import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';

export const ResourceKeySchema=z.string().min(1).max(270).transform(raw=>raw.toLowerCase())
 .refine(key=>{
  if(key==='repo')return true;
  if(!key.startsWith('path:'))return false;
  const relative=key.slice(5);
  return relative.length>0&&relative.length<=240&&!relative.startsWith('/')&&
   !relative.endsWith('/')&&/^[a-z0-9._/-]+$/.test(relative)&&
   relative.split('/').every(segment=>segment!=='.'&&segment!=='..'&&!!segment);
 },{message:'Resource must be repo or path:<safe relative path>'});
const RequestResource=z.strictObject({key:ResourceKeySchema,mode:z.enum(['read','write'])});
export const SchedulePlanSchema=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,
 priority:z.number().int().min(0).max(10).default(5),
 resources:z.array(RequestResource).min(1).max(16),
 dependsOn:z.array(UuidSchema).max(32).default([])
}).superRefine((input,ctx)=>{
 const keys=input.resources.map(x=>x.key);
 if(new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',path:['resources'],message:'Duplicate resources'});
 if(keys.includes('repo')&&keys.length>1)ctx.addIssue({code:'custom',path:['resources'],message:'Repo lock must be sole resource'});
 if(new Set(input.dependsOn).size!==input.dependsOn.length||input.dependsOn.includes(input.taskId))
  ctx.addIssue({code:'custom',path:['dependsOn'],message:'Invalid dependencies'});
});
export type SchedulePlan=z.input<typeof SchedulePlanSchema>;
type Resource={key:string;mode:'read'|'write'};
export type Claim={taskId:string;projectId:string;workerId:string;leaseToken:string;fence:number;leaseUntil:string;priority:number;resources:Resource[]};
export class SchedulerConflict extends Error {readonly status=409;}
export class SchedulerNotFound extends Error {readonly status=404;}
export class SchedulerBadRequest extends Error {readonly status=400;}
const iso=(x:unknown)=>x instanceof Date?x.toISOString():String(x);
const workerSchema=z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/);
const ttlSchema=z.number().int().min(250).max(120000);
const overlap=(a:string,b:string)=>a==='repo'||b==='repo'||a===b||
 (a.startsWith('path:')&&b.startsWith('path:')&&(a.startsWith(b+'/')||b.startsWith(a+'/')));
const conflicts=(a:Resource[],b:Resource[])=>a.some(x=>b.some(y=>
 (x.mode==='write'||y.mode==='write')&&overlap(x.key,y.key)));
export function resourcesConflict(a:readonly Resource[],b:readonly Resource[]):boolean{
 return conflicts([...a],[...b]);
}
type Row={task_id:string;project_id:string;priority:number;worker_id:string;lease_token:string;fence:string;lease_until:Date};
export class ResourceScheduler{
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 private async transaction<T>(projectId:string,fn:(client:PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   // Serialize short scheduling decisions within project; leases allow unrelated jobs
   // to RUN concurrently after commit. Fixed one-lock order prevents scheduler deadlock.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,15010))',['scheduler:'+projectId]);
   const result=await fn(c);
   await c.query('COMMIT');
   return result;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async register(raw:SchedulePlan):Promise<{taskId:string;priority:number;resources:Resource[];dependsOn:string[]}>{
  const plan=SchedulePlanSchema.parse(raw);
  const resources=plan.resources.map(x=>({key:x.key,mode:x.mode}));
  return this.transaction(plan.projectId,async c=>{
   const task=await c.query('SELECT status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',
    [plan.taskId,plan.projectId]);
   if(!task.rowCount)throw new SchedulerNotFound('Task not found for project');
   if(task.rows[0].status!=='created')throw new SchedulerConflict('Only created tasks can register resource plans');
   const exists=await c.query('SELECT 1 FROM scheduled_tasks WHERE project_id=$1 AND task_id=$2',[plan.projectId,plan.taskId]);
   if(exists.rowCount)throw new SchedulerConflict('Task already scheduled');
   if(plan.dependsOn.length){
    const dependencies=await c.query('SELECT task_id FROM scheduled_tasks WHERE project_id=$1 AND task_id=ANY($2::uuid[])',
     [plan.projectId,plan.dependsOn]);
    if(dependencies.rowCount!==plan.dependsOn.length)
     throw new SchedulerConflict('Dependency is missing or belongs to another project');
   }
   await c.query('INSERT INTO scheduled_tasks(project_id,task_id,priority) VALUES($1,$2,$3)',
    [plan.projectId,plan.taskId,plan.priority]);
   for(const resource of resources)await c.query(
    'INSERT INTO scheduled_resources(project_id,task_id,resource_key,access_mode) VALUES($1,$2,$3,$4)',
    [plan.projectId,plan.taskId,resource.key,resource.mode]);
   for(const dep of plan.dependsOn)await c.query(
    'INSERT INTO scheduled_dependencies(project_id,task_id,depends_on) VALUES($1,$2,$3)',
    [plan.projectId,plan.taskId,dep]);
   return {taskId:plan.taskId,priority:plan.priority,resources,dependsOn:plan.dependsOn};
  });
 }
 private async expire(c:PoolClient,projectId:string):Promise<number>{
  const r=await c.query(
   `UPDATE scheduled_tasks SET state='queued',worker_id=NULL,lease_token=NULL,
      lease_until=NULL,updated_at=now()
     WHERE project_id=$1 AND state='running' AND lease_until<=clock_timestamp() RETURNING task_id`,[projectId]);
  if(r.rowCount)await c.query(
   `DELETE FROM resource_leases WHERE project_id=$1
      AND task_id=ANY($2::uuid[])`,[projectId,r.rows.map(x=>x.task_id)]);
  return r.rowCount??0;
 }
 async claim(projectId:string,workerId:string,ttlMs=30000):Promise<Claim|null>{
  UuidSchema.parse(projectId);workerSchema.parse(workerId);ttlSchema.parse(ttlMs);
  return this.transaction(projectId,async c=>{
   await this.expire(c,projectId);
   const queued=await c.query(
    `SELECT q.task_id,q.priority FROM scheduled_tasks q
      WHERE q.project_id=$1 AND q.state='queued' AND NOT EXISTS (
       SELECT 1 FROM scheduled_dependencies d
       JOIN scheduled_tasks parent ON parent.project_id=d.project_id AND parent.task_id=d.depends_on
       WHERE d.project_id=q.project_id AND d.task_id=q.task_id AND parent.state<>'completed'
      ) ORDER BY q.priority DESC,q.created_at ASC,q.task_id ASC LIMIT 1000`,[projectId]);
   if(!queued.rowCount)return null;
   const active=await c.query<{task_id:string;resource_key:string;access_mode:'read'|'write'}>(
    'SELECT task_id,resource_key,access_mode FROM resource_leases WHERE project_id=$1 AND expires_at>clock_timestamp()',
    [projectId]);
   const owners=new Map<string,Resource[]>();
   for(const item of active.rows){
    const group=owners.get(item.task_id)??[];
    group.push({key:item.resource_key,mode:item.access_mode});owners.set(item.task_id,group);
   }
   for(const row of queued.rows){
    const found=await c.query<{resource_key:string;access_mode:'read'|'write'}>(
     'SELECT resource_key,access_mode FROM scheduled_resources WHERE project_id=$1 AND task_id=$2 ORDER BY resource_key',
     [projectId,row.task_id]);
    const required=found.rows.map(x=>({key:x.resource_key,mode:x.access_mode}));
    if([...owners.values()].some(held=>resourcesConflict(required,held)))continue;
    const leaseToken=randomUUID();
    const granted=await c.query<Row>(
     `UPDATE scheduled_tasks SET state='running',worker_id=$3,lease_token=$4,
       fence=fence+1,lease_until=clock_timestamp()+($5::int * interval '1 millisecond'),updated_at=now()
       WHERE project_id=$1 AND task_id=$2 AND state='queued'
       RETURNING project_id,task_id,worker_id,lease_token,fence,priority,lease_until`,
     [projectId,row.task_id,workerId,leaseToken,ttlMs]);
    if(!granted.rowCount)throw new SchedulerConflict('Claim changed concurrently');
    const picked=granted.rows[0]!;
    for(const item of required)await c.query(
     `INSERT INTO resource_leases(project_id,task_id,resource_key,access_mode,fence,expires_at)
      SELECT project_id,task_id,$3,$4,fence,lease_until FROM scheduled_tasks
       WHERE project_id=$1 AND task_id=$2`,
     [projectId,picked.task_id,item.key,item.mode]);
    return {projectId,taskId:picked.task_id,workerId,leaseToken,
     fence:Number(picked.fence),leaseUntil:iso(picked.lease_until),
     priority:picked.priority,resources:required};
   }
   return null;
  });
 }
 async heartbeat(projectId:string,taskId:string,workerId:string,leaseToken:string,fence:number,ttlMs=30000):Promise<string|null>{
  this.checkLease(projectId,taskId,workerId,leaseToken,fence,ttlMs);
  return this.transaction(projectId,async c=>{
   const r=await c.query<{lease_until:Date}>(
    `UPDATE scheduled_tasks SET lease_until=clock_timestamp()+($6::int * interval '1 millisecond'),updated_at=now()
     WHERE project_id=$1 AND task_id=$2 AND worker_id=$3 AND lease_token=$4 AND fence=$5
       AND state='running' AND lease_until>clock_timestamp() RETURNING lease_until`,
    [projectId,taskId,workerId,leaseToken,fence,ttlMs]);
   if(!r.rowCount)return null;
   await c.query(
    `UPDATE resource_leases r SET expires_at=s.lease_until
     FROM scheduled_tasks s WHERE r.project_id=$1 AND r.task_id=$2
      AND s.project_id=r.project_id AND s.task_id=r.task_id`,
    [projectId,taskId]);
   return iso(r.rows[0]!.lease_until);
  });
 }
 async complete(projectId:string,taskId:string,workerId:string,leaseToken:string,fence:number):Promise<boolean>{
  this.checkLease(projectId,taskId,workerId,leaseToken,fence);
  return this.transaction(projectId,async c=>{
   const result=await c.query(
    `UPDATE scheduled_tasks SET state='completed',lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=now()
      WHERE project_id=$1 AND task_id=$2 AND worker_id=$3 AND lease_token=$4 AND fence=$5
       AND state='running' AND lease_until>clock_timestamp() RETURNING task_id`,
    [projectId,taskId,workerId,leaseToken,fence]);
   if(!result.rowCount)return false;
   await c.query('DELETE FROM resource_leases WHERE project_id=$1 AND task_id=$2',[projectId,taskId]);
   return true;
  });
 }
 async cancel(projectId:string,taskId:string):Promise<boolean>{
  UuidSchema.parse(projectId);UuidSchema.parse(taskId);
  return this.transaction(projectId,async c=>{
   const r=await c.query(
    `UPDATE scheduled_tasks SET state='cancelled',lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=now()
     WHERE project_id=$1 AND task_id=$2 AND state IN ('queued','running') RETURNING task_id`,
    [projectId,taskId]);
   if(!r.rowCount)return false;
   await c.query('DELETE FROM resource_leases WHERE project_id=$1 AND task_id=$2',[projectId,taskId]);
   // Cancel dependent plans transitively, because a cancelled prerequisite cannot complete.
   await c.query(`WITH RECURSIVE blocked(task_id) AS (
       SELECT d.task_id FROM scheduled_dependencies d WHERE d.project_id=$1 AND d.depends_on=$2
       UNION SELECT d.task_id FROM scheduled_dependencies d JOIN blocked b ON b.task_id=d.depends_on
         WHERE d.project_id=$1
      )
      UPDATE scheduled_tasks SET state='cancelled',lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=now()
      WHERE project_id=$1 AND task_id IN (SELECT task_id FROM blocked) AND state='queued'`,[projectId,taskId]);
   return true;
  });
 }
 async get(projectId:string,taskId:string){
  UuidSchema.parse(projectId);UuidSchema.parse(taskId);
  const rows=await this.pool.query('SELECT project_id,task_id,priority,state,worker_id,fence,lease_until FROM scheduled_tasks WHERE project_id=$1 AND task_id=$2',[projectId,taskId]);
  if(!rows.rowCount)return null;
  const item=rows.rows[0];
  const [resources,deps]=await Promise.all([
   this.pool.query('SELECT resource_key AS key,access_mode AS mode FROM scheduled_resources WHERE project_id=$1 AND task_id=$2 ORDER BY resource_key',[projectId,taskId]),
   this.pool.query('SELECT depends_on FROM scheduled_dependencies WHERE project_id=$1 AND task_id=$2 ORDER BY depends_on',[projectId,taskId])
  ]);
  return {projectId,taskId,priority:item.priority,state:item.state,
   workerId:item.worker_id,fence:Number(item.fence),
   leaseUntil:item.lease_until?iso(item.lease_until):null,
   resources:resources.rows,dependsOn:deps.rows.map(x=>x.depends_on)};
 }
 private checkLease(projectId:string,taskId:string,workerId:string,leaseToken:string,fence:number,ttlMs?:number){
  UuidSchema.parse(projectId);UuidSchema.parse(taskId);UuidSchema.parse(leaseToken);
  workerSchema.parse(workerId);
  if(!Number.isSafeInteger(fence)||fence<1)throw new SchedulerBadRequest('Invalid fencing token');
  if(ttlMs!==undefined)ttlSchema.parse(ttlMs);
 }
}
