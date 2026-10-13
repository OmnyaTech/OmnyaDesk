import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {TaskOrchestrator} from '../dist/packages/db/src/orchestration.js';
import {WorkerQueue} from '../dist/packages/db/src/worker-queue.js';
if(!process.env.DATABASE_URL){
 console.log('SKIP: compiled worker smoke requires DATABASE_URL (CI supplies PostgreSQL)');
}else{
 const pool=createPool(process.env.DATABASE_URL);
 try{
  const id=randomUUID(),repo=new PostgresOfficeRepository(pool),orchestrator=new TaskOrchestrator(pool);
  const queue=new WorkerQueue(pool);
  const {project,office}=await repo.createProject({ownerId:id,name:'S06 compiled worker '+id,repositoryRoot:null,template:'custom'});
  const task=await repo.createTask({projectId:project.id,officeId:office.id,requestedBy:id,title:'Compiled worker smoke',description:''});
  const started=await orchestrator.transition({
   projectId:project.id,taskId:task.id,expectedVersion:1,to:'queued',
   reason:null,actor:{kind:'system',id:'system'},source:'system',commandKey:randomUUID()});
  const runId=started.task.currentRunId;
  assert.ok(runId);
  const invocation=spawnSync(process.execPath,['dist/apps/worker/src/main.js','--once'],{
   cwd:process.cwd(),windowsHide:true,encoding:'utf8',timeout:15000,
   env:{...process.env,WORKER_PROJECT_ID:project.id,WORKER_LEASE_MS:'500',WORKER_SIMULATED_MS:'80'}
  });
  assert.equal(invocation.status,0,invocation.stderr||invocation.stdout);
  assert.match(invocation.stdout,/S06_RESULT succeeded/);
  const job=await queue.byRun(runId);
  assert.equal(job?.status,'succeeded');
  assert.equal(job?.attemptCount,1);
  assert.equal(await queue.effectCount(runId),1);
  const repeated=await queue.claim('smoke-repeat',500,project.id);
  assert.equal(repeated,null);
  console.log('PASS: compiled worker claim, completion, durable effect and deduplication');
 }finally{await pool.end();}
}
