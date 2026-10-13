import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TaskOrchestrator,WorkflowConflict,WorkflowNotFound} from '../packages/db/src/orchestration.ts';
import type {TaskLifecycleState} from '../packages/contracts/src/domain.ts';

const url=process.env.DATABASE_URL;
let pool:Pool,repo:PostgresOfficeRepository,orchestrator:TaskOrchestrator;
const system={kind:'system',id:'system'} as const;
const actorId=randomUUID(),human={kind:'human',id:actorId} as const;
const setup=async()=>{
 const p=await repo.createProject({ownerId:actorId,name:'S05 '+randomUUID(),repositoryRoot:null,template:'startup'});
 const task=await repo.createTask({projectId:p.project.id,officeId:p.office.id,requestedBy:actorId,title:'FSM suite',description:''});
 return {projectId:p.project.id,taskId:task.id,task};
};
type Target={projectId:string;taskId:string};
const move=(x:Target,expectedVersion:number,to:TaskLifecycleState,opts:{
 key?:string; reason?:string|null; who?:typeof system|typeof human
}={})=>orchestrator.transition({
 projectId:x.projectId,taskId:x.taskId,expectedVersion,to,commandKey:opts.key??randomUUID(),
 reason:opts.reason??null,actor:opts.who??system,source:'system',
});
before(async()=>{if(!url)return;pool=createPool(url);await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);orchestrator=new TaskOrchestrator(pool);});
after(async()=>{if(pool)await pool.end();});

test('S05 migration is idempotent and S04 events were backfilled to the outbox',{skip:!url},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 const migrations=await pool.query('SELECT name FROM schema_migrations WHERE name=$1',['002_task_fsm_outbox.sql']);
 assert.equal(migrations.rowCount,1);
 const missing=await pool.query(
  `SELECT e.event_id FROM task_events e LEFT JOIN task_outbox o ON e.event_id=o.event_id WHERE o.id IS NULL LIMIT 1`);
 assert.equal(missing.rowCount,0);
});

test('S05 task creation writes event and outbox in a single committed transaction',{skip:!url},async()=>{
 const x=await setup(),e=await repo.listEvents(x.projectId);
 const out=await orchestrator.listOutbox(x.projectId);
 assert.equal(e.length,1);assert.equal(out.length,1);
 assert.equal(out[0]!.event.eventId,e[0]!.eventId);
 assert.equal(out[0]!.event.type,'task.created');
});

test('S05 normal FSM path uses one run and human approval',{skip:!url},async()=>{
 const x=await setup();
 let v=1,firstRun:string|null=null;
 for(const next of ['queued','planning','implementing','testing','reviewing','awaiting_approval'] as TaskLifecycleState[]){
  const result=await move(x,v,next);
  assert.equal(result.task.version,v+1);assert.equal(result.task.status,next);
  assert.equal(result.event.payload && result.event.type,'task.status_changed');
  assert.equal(result.replayed,false);
  if(next==='queued')firstRun=result.task.currentRunId;
  else assert.equal(result.task.currentRunId,firstRun);
  v++;
 }
 assert.ok(firstRun);
 await assert.rejects(move(x,v,'approved'),WorkflowConflict);
 const approved=await move(x,v,'approved',{who:human});
 assert.equal(approved.task.status,'approved');
 assert.equal(approved.event.actor.kind,'human');
 assert.equal(approved.task.currentRunId,firstRun);
 assert.equal((await repo.listEvents(x.projectId)).length,8);
 assert.equal((await orchestrator.listOutbox(x.projectId)).length,8);
 await assert.rejects(move(x,approved.task.version,'planning'),WorkflowConflict);
});

test('S05 rejected approval returns to queue in a newly persisted run',{skip:!url},async()=>{
 const x=await setup();
 let version=1;
 for(const step of ['queued','planning','implementing','testing','reviewing','awaiting_approval'] as TaskLifecycleState[]){
  const result=await move(x,version++,step);
  assert.equal(result.task.status,step);
 }
 await assert.rejects(move(x,version,'changes_requested'),WorkflowConflict);
 const rejected=await move(x,version++,'changes_requested',{who:human,reason:'QA corrections'});
 assert.equal(rejected.task.status,'changes_requested');
 const previousRun=rejected.task.currentRunId;
 const returned=await move(x,version,'queued');
 assert.notEqual(returned.task.currentRunId,previousRun);
 assert.equal(returned.event.type,'task.status_changed');
 if(returned.event.type==='task.status_changed')
  assert.equal(returned.event.payload.newRunId,returned.task.currentRunId);
 const attempts=await pool.query('SELECT attempt FROM task_runs WHERE task_id=$1 ORDER BY attempt',[x.taskId]);
 assert.deepEqual(attempts.rows.map(v=>v.attempt),[1,2]);
});

test('S05 illegal transitions and stale version leave no side effects',{skip:!url},async()=>{
 const x=await setup();
 await assert.rejects(move(x,1,'approved',{who:human}),WorkflowConflict);
 await assert.rejects(move(x,22,'queued'),WorkflowConflict);
 await assert.rejects(move(x,1,'implementing'),WorkflowConflict);
 assert.equal((await repo.listTasks(x.projectId))[0]!.version,1);
 assert.equal((await repo.listEvents(x.projectId)).length,1);
 assert.equal((await orchestrator.listOutbox(x.projectId)).length,1);
});

test('S05 24 simultaneous retries using ONE idempotency key produce one transition',{skip:!url},async()=>{
 const x=await setup(),key=randomUUID();
 const results=await Promise.all(Array.from({length:24},()=>move(x,1,'queued',{key})));
 assert.equal(results.filter(r=>r.replayed===false).length,1);
 assert.equal(results.filter(r=>r.replayed===true).length,23);
 assert.equal(new Set(results.map(r=>r.event.eventId)).size,1);
 assert.equal((await repo.listEvents(x.projectId)).length,2);
 assert.equal((await orchestrator.listOutbox(x.projectId)).length,2);
 const stored=await pool.query('SELECT COUNT(*)::int AS n FROM task_commands WHERE task_id=$1',[x.taskId]);
 assert.equal(stored.rows[0].n,1);
});

test('S05 two different concurrent commands at same version cannot both commit',{skip:!url},async()=>{
 const x=await setup();
 const r=await Promise.allSettled([move(x,1,'queued'),move(x,1,'cancelled')]);
 assert.equal(r.filter(v=>v.status==='fulfilled').length,1);
 assert.equal(r.filter(v=>v.status==='rejected').length,1);
 assert.equal((await repo.listEvents(x.projectId)).length,2);
 assert.equal((await orchestrator.listOutbox(x.projectId)).length,2);
});

test('S05 reuse of a command key with changed intent is rejected without mutation',{skip:!url},async()=>{
 const x=await setup(),key=randomUUID();
 const previous=await move(x,1,'queued',{key});
 await assert.rejects(move(x,1,'cancelled',{key}),WorkflowConflict);
 const retry=await move(x,1,'queued',{key});
 assert.deepEqual(retry.task,previous.task);
 assert.deepEqual(retry.event,previous.event);
 assert.equal(retry.replayed,true);
 assert.equal((await repo.listEvents(x.projectId)).length,2);
});

test('S05 same command key remains stable after later state changes and reconnect',{skip:!url},async()=>{
 const x=await setup(),key=randomUUID();
 const first=await move(x,1,'queued',{key});
 await move(x,2,'planning');
 const another=createPool(url!);
 try{
  const later=new TaskOrchestrator(another);
  const replay=await later.transition({
   projectId:x.projectId,taskId:x.taskId,commandKey:key,
   expectedVersion:1,to:'queued',reason:null,actor:system,source:'system'
  });
  assert.equal(replay.replayed,true);
  assert.equal(replay.task.version,first.task.version);
  assert.equal(replay.event.eventId,first.event.eventId);
  assert.equal((await repo.listTasks(x.projectId))[0]!.status,'planning');
 }finally{await another.end();}
});

test('S05 wrong project cannot mutate another project task',{skip:!url},async()=>{
 const a=await setup(),b=await setup();
 await assert.rejects(move({projectId:b.projectId,taskId:a.taskId},1,'queued'),WorkflowNotFound);
 assert.equal((await repo.listTasks(a.projectId))[0]!.status,'created');
 assert.equal((await orchestrator.listOutbox(a.projectId)).length,1);
});

test('S05 outbox is append-only in payload and can replay by cursor',{skip:!url},async()=>{
 const x=await setup();
 await move(x,1,'queued');await move(x,2,'planning');
 const list=await orchestrator.listOutbox(x.projectId);
 assert.equal(list.length,3);
 assert.deepEqual((await orchestrator.listOutbox(x.projectId,list[0]!.id)).map(v=>v.id),list.slice(1).map(v=>v.id));
 assert.equal(new Set(list.map(v=>v.event.eventId)).size,3);
 await assert.rejects(pool.query('UPDATE task_outbox SET payload=$1 WHERE id=$2',['{}',list[1]!.id]));
 await assert.rejects(pool.query('DELETE FROM task_outbox WHERE id=$1',[list[1]!.id]));
 assert.equal((await orchestrator.listOutbox(x.projectId)).length,3);
});

test('S05 outbox cursor order matches committed event order under parallel tasks',{skip:!url},async()=>{
 const ownerId=randomUUID();
 const p=await repo.createProject({ownerId,name:'Parallel Cursor '+randomUUID(),repositoryRoot:null,template:'startup'});
 const tasks=await Promise.all(Array.from({length:12},async (_,i)=>{
  const task=await repo.createTask({projectId:p.project.id,officeId:p.office.id,requestedBy:ownerId,
   title:'Concurrent '+i,description:''});
  await move({projectId:p.project.id,taskId:task.id},1,'queued');
  return task.id;
 }));
 assert.equal(tasks.length,12);
 const messages=await orchestrator.listOutbox(p.project.id);
 assert.equal(messages.length,24);
 const sequences=messages.map(m=>m.event.sequence);
 assert.deepEqual(sequences,[...sequences].sort((a,b)=>a-b));
 assert.equal(new Set(messages.map(m=>m.event.eventId)).size,24);
});

test('S05 outbox insertion failure rolls back task, event, run and command',{skip:!url},async()=>{
 const x=await setup(),eventBefore=(await repo.listEvents(x.projectId)).length;
 await pool.query(`CREATE FUNCTION s05_test_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.payload->'payload'->>'reason'='s05-rollback-marker' THEN
    RAISE EXCEPTION 'synthetic outbox failure';
  END IF; RETURN NEW; END $$`);
 await pool.query('CREATE TRIGGER s05_injection BEFORE INSERT ON task_outbox FOR EACH ROW EXECUTE FUNCTION s05_test_outbox_fail()');
 try {
  await assert.rejects(move(x,1,'queued',{reason:'s05-rollback-marker'}),/synthetic outbox failure/);
  assert.equal((await repo.listTasks(x.projectId))[0]!.version,1);
  assert.equal((await repo.listEvents(x.projectId)).length,eventBefore);
  assert.equal((await orchestrator.listOutbox(x.projectId)).length,eventBefore);
  assert.equal(Number((await pool.query('SELECT COUNT(*) FROM task_runs WHERE task_id=$1',[x.taskId])).rows[0].count),0);
  assert.equal(Number((await pool.query('SELECT COUNT(*) FROM task_commands WHERE task_id=$1',[x.taskId])).rows[0].count),0);
 }finally{
  await pool.query('DROP TRIGGER IF EXISTS s05_injection ON task_outbox');
  await pool.query('DROP FUNCTION IF EXISTS s05_test_outbox_fail()');
 }
 const good=await move(x,1,'queued');assert.equal(good.task.version,2);
});
