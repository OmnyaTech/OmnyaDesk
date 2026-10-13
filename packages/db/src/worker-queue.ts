import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';

const workerIdSchema=z.string().trim().min(1).max(128);
const leaseSchema=z.number().int().min(100).max(300000);
const attemptsSchema=z.number().int().min(1).max(20);
const maxBackoff=60000;
export type JobStatus='queued'|'running'|'succeeded'|'failed'|'cancelled';
export type WorkerJob={
 id:string; projectId:string;taskId:string;runId:string;status:JobStatus;
 attemptCount:number;maxAttempts:number;leaseOwner:string|null;leaseToken:string|null;
 leasedUntil:Date|null;cancelRequested:boolean;lastError:string|null;result:unknown;
};
export class LeaseLostError extends Error {}
const mapJob=(row:Record<string,unknown>):WorkerJob=>({
 id:String(row.id),projectId:String(row.project_id),taskId:String(row.task_id),
 runId:String(row.run_id),status:row.status as JobStatus,
 attemptCount:Number(row.attempt_count),maxAttempts:Number(row.max_attempts),
 leaseOwner:row.lease_owner===null?null:String(row.lease_owner),
 leaseToken:row.lease_token===null?null:String(row.lease_token),
 leasedUntil:row.leased_until instanceof Date?row.leased_until:null,
 cancelRequested:Boolean(row.cancel_requested),lastError:row.last_error===null?null:String(row.last_error),
 result:row.result
});
const validLease=(workerId:string,token:string,leaseMs:number)=>{
 workerIdSchema.parse(workerId);UuidSchema.parse(token);leaseSchema.parse(leaseMs);
};
const withTransaction=async<T>(pool:Pool,work:(c:PoolClient)=>Promise<T>):Promise<T>=>{
 const c=await pool.connect();
 try{await c.query('BEGIN');const data=await work(c);await c.query('COMMIT');return data;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
};
export class WorkerQueue {
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async get(jobId:string):Promise<WorkerJob|null>{
  UuidSchema.parse(jobId);
  const rows=await this.pool.query('SELECT * FROM worker_jobs WHERE id=$1',[jobId]);
  return rows.rowCount?mapJob(rows.rows[0]):null;
 }
 async byRun(runId:string):Promise<WorkerJob|null>{
  UuidSchema.parse(runId);
  const rows=await this.pool.query('SELECT * FROM worker_jobs WHERE run_id=$1',[runId]);
  return rows.rowCount?mapJob(rows.rows[0]):null;
 }
 async setMaxAttempts(jobId:string,maxAttempts:number):Promise<void>{
  UuidSchema.parse(jobId);attemptsSchema.parse(maxAttempts);
  const res=await this.pool.query(
   "UPDATE worker_jobs SET max_attempts=$2,updated_at=now() WHERE id=$1 AND status='queued' AND attempt_count=0",
   [jobId,maxAttempts]);
  if(res.rowCount!==1)throw new Error('Maximum attempts can only change on unclaimed jobs');
 }
 async claim(workerId:string,leaseMs=3000,projectId?:string):Promise<WorkerJob|null>{
  workerIdSchema.parse(workerId);leaseSchema.parse(leaseMs);
  if(projectId)UuidSchema.parse(projectId);
  const token=randomUUID();
  return withTransaction(this.pool,async c=>{
   const selected=await c.query<{id:string}>(
    `SELECT id FROM worker_jobs WHERE status='queued' AND available_at<=now()
       AND cancel_requested=false AND ($1::uuid IS NULL OR project_id=$1::uuid)
       ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[projectId??null]);
   if(!selected.rowCount)return null;
   const result=await c.query(
    `UPDATE worker_jobs SET status='running',attempt_count=attempt_count+1,
      lease_owner=$2,lease_token=$3,
      leased_until=now()+($4::integer * interval '1 millisecond'),
      heartbeat_at=now(),updated_at=now()
      WHERE id=$1 AND status='queued' AND attempt_count<max_attempts RETURNING *`,
    [selected.rows[0]!.id,workerId,token,leaseMs]);
   return result.rowCount?mapJob(result.rows[0]):null;
  });
 }
 async heartbeat(jobId:string,workerId:string,token:string,leaseMs=3000):Promise<boolean>{
  UuidSchema.parse(jobId);validLease(workerId,token,leaseMs);
  const row=await this.pool.query(
   `UPDATE worker_jobs SET leased_until=now()+($4::integer * interval '1 millisecond'),
    heartbeat_at=now(),updated_at=now()
    WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3
    AND leased_until>now() AND NOT cancel_requested RETURNING id`,
   [jobId,workerId,token,leaseMs]);
  return row.rowCount===1;
 }
 async complete(jobId:string,workerId:string,token:string,output:Record<string,unknown>):Promise<boolean>{
  UuidSchema.parse(jobId);workerIdSchema.parse(workerId);UuidSchema.parse(token);
  if(!output||typeof output!=='object'||Array.isArray(output))throw Error('Worker output must be an object');
  const data=JSON.stringify(output);
  if(data.length>64000)throw Error('Worker output exceeds 64 KB');
  return withTransaction(this.pool,async c=>{
   const row=await c.query(
    `SELECT * FROM worker_jobs WHERE id=$1 FOR UPDATE`,[jobId]);
   if(!row.rowCount)return false;
   const job=mapJob(row.rows[0]);
   if(job.status!=='running'||job.leaseOwner!==workerId||job.leaseToken!==token||
     job.cancelRequested||!job.leasedUntil||job.leasedUntil.getTime()<=Date.now())return false;
   await c.query(
    'INSERT INTO worker_effects(run_id,job_id,output) VALUES($1,$2,$3::jsonb) ON CONFLICT(run_id) DO NOTHING',
    [job.runId,job.id,data]);
   const result=await c.query(
    `UPDATE worker_jobs SET status='succeeded',result=$2::jsonb,lease_owner=NULL,
      lease_token=NULL,leased_until=NULL,finished_at=now(),updated_at=now()
      WHERE id=$1 AND status='running' RETURNING id`,[jobId,data]);
   return result.rowCount===1;
  });
 }
 async fail(jobId:string,workerId:string,token:string,error:string,baseDelayMs=100):Promise<JobStatus|null>{
  UuidSchema.parse(jobId);workerIdSchema.parse(workerId);UuidSchema.parse(token);
  if(!Number.isSafeInteger(baseDelayMs)||baseDelayMs<0||baseDelayMs>maxBackoff)throw Error('Bad retry delay');
  return withTransaction(this.pool,async c=>{
   const res=await c.query('SELECT * FROM worker_jobs WHERE id=$1 FOR UPDATE',[jobId]);
   if(!res.rowCount)return null;
   const job=mapJob(res.rows[0]);
   if(job.status!=='running'||job.leaseOwner!==workerId||job.leaseToken!==token||
      !job.leasedUntil||job.leasedUntil.getTime()<=Date.now())return null;
   const next:JobStatus=job.cancelRequested?'cancelled':job.attemptCount>=job.maxAttempts?'failed':'queued';
   const wait=Math.min(maxBackoff,baseDelayMs*2**(job.attemptCount-1));
   await c.query(
    `UPDATE worker_jobs SET status=$2,lease_owner=NULL,lease_token=NULL,leased_until=NULL,
      updated_at=now(),finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,
      available_at=now()+($3::integer*interval '1 millisecond'),last_error=$4
      WHERE id=$1`,[jobId,next,wait,error.slice(0,1000)]);
   return next;
  });
 }
 async cancel(jobId:string):Promise<JobStatus|null>{
  UuidSchema.parse(jobId);
  return withTransaction(this.pool,async c=>{
   const res=await c.query('SELECT * FROM worker_jobs WHERE id=$1 FOR UPDATE',[jobId]);
   if(!res.rowCount)return null;
   const job=mapJob(res.rows[0]);
   if(job.status==='queued'){
    await c.query(`UPDATE worker_jobs SET status='cancelled',cancel_requested=true,
      finished_at=now(),updated_at=now() WHERE id=$1`,[jobId]);
    return 'cancelled';
   }
   if(job.status==='running'){
    await c.query('UPDATE worker_jobs SET cancel_requested=true,updated_at=now() WHERE id=$1',[jobId]);
   }
   return job.status;
  });
 }
 async reapExpired(limit=50,projectId?:string):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('Bad reap limit');
  if(projectId)UuidSchema.parse(projectId);
  return withTransaction(this.pool,async c=>{
   const rows=await c.query<{id:string}>(
    `SELECT id FROM worker_jobs WHERE status='running' AND leased_until<=now()
      AND ($2::uuid IS NULL OR project_id=$2::uuid)
      ORDER BY leased_until,id FOR UPDATE SKIP LOCKED LIMIT $1`,[limit,projectId??null]);
   for(const row of rows.rows){
    await c.query(
     `UPDATE worker_jobs SET
       status=CASE WHEN cancel_requested THEN 'cancelled'
          WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'queued' END,
       lease_owner=NULL,lease_token=NULL,leased_until=NULL,heartbeat_at=NULL,
       last_error=CASE WHEN cancel_requested THEN 'Cancelled' ELSE 'Lease expired' END,
       finished_at=CASE WHEN cancel_requested OR attempt_count>=max_attempts THEN now() ELSE NULL END,
       available_at=now(),updated_at=now() WHERE id=$1`,[row.id]);
   }
   return rows.rowCount??0;
  });
 }
 async effectCount(runId:string):Promise<number>{
  UuidSchema.parse(runId);
  const row=await this.pool.query<{count:string}>('SELECT count(*)::text AS count FROM worker_effects WHERE run_id=$1',[runId]);
  return Number(row.rows[0]!.count);
 }
}
