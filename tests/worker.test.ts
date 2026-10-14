import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TaskOrchestrator} from '../packages/db/src/orchestration.ts';
import {WorkerQueue} from '../packages/db/src/worker-queue.ts';
import {WorkerRuntime,simulatedWork} from '../packages/db/src/worker-runtime.ts';
const databaseUrl=process.env.DATABASE_URL;
let pool:Pool,repo:PostgresOfficeRepository,workflow:TaskOrchestrator,queue:WorkerQueue;
const owner=randomUUID();
type Scenario={projectId:string;taskId:string;runId:string;jobId:string};
const create=async():Promise<Scenario>=>{
 const project=await repo.createProject({ownerId:owner,name:'S06 Queue '+randomUUID(),repositoryRoot:null,template:'startup'});
 const task=await repo.createTask({projectId:project.project.id,officeId:project.office.id,requestedBy:owner,title:'S06 isolated',description:''});
 const queued=await workflow.transition({projectId:project.project.id,taskId:task.id,
  expectedVersion:1,to:'queued',commandKey:randomUUID(),reason:null,
  actor:{kind:'system',id:'system'},source:'system'});
 const runId=queued.task.currentRunId!;
 const job=await queue.byRun(runId);
 assert.ok(job);
 return {projectId:project.project.id,taskId:task.id,runId,jobId:job.id};
};
const claim=(s:Scenario,worker='s06-w1',lease=500)=>queue.claim(worker,lease,s.projectId);
before(async()=>{
 if(!databaseUrl)return;
 pool=createPool(databaseUrl);await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);workflow=new TaskOrchestrator(pool);queue=new WorkerQueue(pool);
});
after(async()=>{if(pool)await pool.end();});

test('S06 migration registered and rerun does not change schema',{skip:!databaseUrl},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 const rows=await pool.query('SELECT name FROM schema_migrations WHERE name=$1',['003_worker_queue.sql']);
 assert.equal(rows.rowCount,1);
});

test('S06 queued transition creates exactly one durable job in the SAME transaction',{skip:!databaseUrl},async()=>{
 const s=await create();
 const job=await queue.byRun(s.runId);
 assert.equal(job?.status,'queued');assert.equal(job?.attemptCount,0);
 assert.equal(job?.maxAttempts,3);
 assert.equal((await repo.listEvents(s.projectId)).length,2);
 const jobs=await pool.query('SELECT count(*)::int AS n FROM worker_jobs WHERE run_id=$1',[s.runId]);
 assert.equal(jobs.rows[0].n,1);
});

test('S06 cancelling a task also cancels its job atomically',{skip:!databaseUrl},async()=>{
 const s=await create();
 const result=await workflow.transition({
  projectId:s.projectId,taskId:s.taskId,expectedVersion:2,to:'cancelled',
  commandKey:randomUUID(),reason:'Cancel user task',actor:{kind:'system',id:'system'},source:'system'
 });
 assert.equal(result.task.status,'cancelled');
 assert.equal((await queue.byRun(s.runId))?.status,'cancelled');
 assert.equal(await claim(s,'no-claim'),null);
 assert.equal(await queue.effectCount(s.runId),0);
});
test('S06 cancellation of running task revokes worker completion',{skip:!databaseUrl},async()=>{
 const s=await create(),claimed=(await claim(s,'busy-worker',300))!;
 await workflow.transition({
  projectId:s.projectId,taskId:s.taskId,expectedVersion:2,to:'cancelled',
  commandKey:randomUUID(),reason:'Abort in progress',actor:{kind:'system',id:'system'},source:'system'
 });
 assert.equal((await queue.get(s.jobId))?.cancelRequested,true);
 assert.equal(await queue.heartbeat(s.jobId,'busy-worker',claimed.leaseToken!,300),false);
 assert.equal(await queue.complete(s.jobId,'busy-worker',claimed.leaseToken!,{bad:true}),false);
 assert.equal(await queue.fail(s.jobId,'busy-worker',claimed.leaseToken!,'cancelled'), 'cancelled');
 assert.equal(await queue.effectCount(s.runId),0);
});

test('S06 concurrent workers use SKIP LOCKED and never share a lease',{skip:!databaseUrl},async()=>{
 const s=await create();
 const pair=await Promise.all([claim(s,'one'),claim(s,'two')]);
 assert.equal(pair.filter(Boolean).length,1);
 const active=pair.find(Boolean)!;
 assert.equal(active.status,'running');
 assert.equal(active.attemptCount,1);
 assert.equal(await queue.complete(active.id,active.leaseOwner!,active.leaseToken!,{test:'one'}),true);
 assert.equal(await queue.effectCount(s.runId),1);
 assert.equal(await queue.complete(active.id,active.leaseOwner!,active.leaseToken!,{test:'two'}),false);
 assert.equal(await queue.effectCount(s.runId),1);
});

test('S06 heartbeat refreshes a valid lease and rejects incorrect owner or token',{skip:!databaseUrl},async()=>{
 // Allow for slower CI PostgreSQL I/O while still crossing the original lease boundary.
 const leaseMs=1600;
 const s=await create(),job=(await claim(s,'heartbeat',leaseMs))!;
 assert.equal(await queue.heartbeat(job.id,'intruder',job.leaseToken!,leaseMs),false);
 assert.equal(await queue.heartbeat(job.id,'heartbeat',randomUUID(),leaseMs),false);
 await delay(700);
 assert.equal(await queue.heartbeat(job.id,'heartbeat',job.leaseToken!,leaseMs),true);
 await delay(1000);
 assert.equal(await queue.reapExpired(5,s.projectId),0);
 assert.equal((await queue.get(job.id))?.status,'running');
 assert.equal(await queue.complete(job.id,'heartbeat',job.leaseToken!,{safe:true}),true);
});

test('S06 cancelling queued work is terminal and prevents claims',{skip:!databaseUrl},async()=>{
 const s=await create();
 assert.equal(await queue.cancel(s.jobId),'cancelled');
 assert.equal(await claim(s,'not-started'),null);
 assert.equal((await queue.get(s.jobId))?.status,'cancelled');
 assert.equal(await queue.effectCount(s.runId),0);
 assert.equal(await queue.cancel(s.jobId),'cancelled');
});

test('S06 cancelling running work revokes heartbeat and forbids committing effects',{skip:!databaseUrl},async()=>{
 const s=await create(),job=(await claim(s,'cancel-inflight',500))!;
 assert.equal(await queue.cancel(job.id),'running');
 assert.equal(await queue.heartbeat(job.id,'cancel-inflight',job.leaseToken!,500),false);
 assert.equal(await queue.complete(job.id,'cancel-inflight',job.leaseToken!,{bad:true}),false);
 assert.equal(await queue.fail(job.id,'cancel-inflight',job.leaseToken!,'cancelled'), 'cancelled');
 assert.equal((await queue.get(s.jobId))?.status,'cancelled');
 assert.equal(await queue.effectCount(s.runId),0);
});

test('S06 failure retries with bound and never performs more than maxAttempts',{skip:!databaseUrl},async()=>{
 const s=await create();await queue.setMaxAttempts(s.jobId,2);
 const first=(await claim(s,'retries'))!;
 assert.equal(first.attemptCount,1);
 assert.equal(await queue.fail(first.id,'retries',first.leaseToken!,'transient',0),'queued');
 const second=(await claim(s,'retries'))!;
 assert.equal(second.attemptCount,2);
 assert.notEqual(first.leaseToken,second.leaseToken);
 assert.equal(await queue.fail(second.id,'retries',second.leaseToken!,'permanent',0),'failed');
 assert.equal(await claim(s,'retries'),null);
 assert.equal((await queue.get(s.jobId))?.attemptCount,2);
 assert.equal(await queue.effectCount(s.runId),0);
});

test('S06 crashed worker lease expires, another worker reclaims, stale token cannot commit',{skip:!databaseUrl},async()=>{
 const s=await create(),first=(await claim(s,'crashed',100))!;
 await delay(175);
 assert.equal(await queue.reapExpired(5,s.projectId),1);
 const second=(await claim(s,'rescued',250))!;
 assert.equal(second.attemptCount,2);
 assert.notEqual(first.leaseToken,second.leaseToken);
 assert.equal(await queue.complete(first.id,'crashed',first.leaseToken!,{bad:true}),false);
 assert.equal(await queue.complete(second.id,'rescued',second.leaseToken!,{ok:true}),true);
 assert.equal(await queue.effectCount(s.runId),1);
 assert.equal((await queue.get(s.jobId))?.status,'succeeded');
});

test('S06 expired final attempt transitions to failed and never resurrects',{skip:!databaseUrl},async()=>{
 const s=await create();await queue.setMaxAttempts(s.jobId,1);
 await claim(s,'dies',100);await delay(160);
 assert.equal(await queue.reapExpired(5,s.projectId),1);
 assert.equal((await queue.get(s.jobId))?.status,'failed');
 assert.equal(await claim(s,'late'),null);
});

test('S06 cancellation of a dead worker becomes terminal on lease recovery',{skip:!databaseUrl},async()=>{
 const s=await create(),job=(await claim(s,'aborted',100))!;
 await queue.cancel(job.id);await delay(165);
 assert.equal(await queue.reapExpired(5,s.projectId),1);
 assert.equal((await queue.get(s.jobId))?.status,'cancelled');
 assert.equal(await queue.effectCount(s.runId),0);
});

test('S06 WorkerRuntime sends periodic heartbeat during long simulated jobs',{skip:!databaseUrl},async()=>{
 const s=await create();const worker=new WorkerRuntime(queue,'s06-live',210,s.projectId);
 const result=await worker.once((j,signal)=>simulatedWork(j,signal,440));
 assert.equal(result,'succeeded');
 assert.equal(await queue.effectCount(s.runId),1);
 const job=await queue.get(s.jobId);
 assert.equal(job?.status,'succeeded');
 assert.equal(job?.attemptCount,1);
});

test('S06 competing processes and distinct project filters cannot steal jobs',{skip:!databaseUrl},async()=>{
 const s=await create(),another=await create();
 assert.equal(await queue.claim('cross',500,another.projectId)!=null,true);
 assert.equal((await queue.get(s.jobId))?.status,'queued');
 const own=(await queue.claim('own',500,s.projectId))!;
 assert.equal(own.projectId,s.projectId);
 assert.equal(await queue.complete(own.id,'own',own.leaseToken!,{ok:true}),true);
});

test('S06 worker runtime reports terminal failure after retry ceiling',{skip:!databaseUrl},async()=>{
 const s=await create();
 await queue.setMaxAttempts(s.jobId,1);
 const runtime=new WorkerRuntime(queue,'terminal-error',500,s.projectId);
 const status=await runtime.once(async()=>{throw new Error('synthetic failure');});
 assert.equal(status,'failed');
 assert.equal((await queue.get(s.jobId))?.status,'failed');
 assert.equal((await queue.get(s.jobId))?.attemptCount,1);
 assert.equal(await queue.effectCount(s.runId),0);
});

test('S06 cancellation, result, max retry and scope preserve persisted invariant after pool reopen',{skip:!databaseUrl},async()=>{
 const s=await create(),first=(await claim(s,'reopen'))!;
 assert.equal(await queue.complete(first.id,'reopen',first.leaseToken!,{marker:'durable'}),true);
 const another=createPool(databaseUrl!);
 try{
  const reopened=new WorkerQueue(another);
  const job=await reopened.byRun(s.runId);
  assert.equal(job?.status,'succeeded');
  assert.deepEqual(job?.result,{marker:'durable'});
  assert.equal(await reopened.effectCount(s.runId),1);
 }finally{await another.end();}
});
