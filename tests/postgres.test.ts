import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';

const connection=process.env.DATABASE_URL;
let pool:Pool|undefined,repo:PostgresOfficeRepository|undefined;
const requireRepo=():PostgresOfficeRepository=>{if(!repo)throw new Error('Postgres test was not initialized');return repo;};
before(async()=>{
 if(!connection)return;
 pool=createPool(connection);
 await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);
});
after(async()=>{await pool?.end();});

test('S04 migrations are idempotent and registered with a checksum',{skip:!connection},async()=>{
 const again=await runMigrations(pool!);
 assert.deepEqual(again,[]);
 const migrations=await pool!.query<{name:string;sha256:string}>('SELECT name,sha256 FROM schema_migrations ORDER BY name');
 assert.ok(migrations.rows.some(m=>m.name==='001_core.sql'&&/^[a-f0-9]{64}$/.test(m.sha256)));
});

test('S04 project, office, task and V1 event persist across pool reconnect',{skip:!connection},async()=>{
 const repo=requireRepo(),ownerId=randomUUID();
 const {project,office}=await repo.createProject({ownerId,name:'S04 integration '+randomUUID(),repositoryRoot:null,template:'startup'});
 assert.equal(project.ownerId,ownerId);
 assert.equal(office.projectId,project.id);
 const task=await repo.createTask({projectId:project.id,officeId:office.id,requestedBy:ownerId,title:'Persistence test',description:'Events are durable'});
 assert.equal(task.status,'created');
 const first=await repo.listEvents(project.id);
 assert.equal(first.length,1);
 assert.equal(first[0]?.type,'task.created');
 assert.equal(first[0]?.taskId,task.id);
 assert.deepEqual(await repo.listEvents(project.id,first[0]!.sequence),[]);
 const alternate=createPool(connection!);
 try {
   const restarted=new PostgresOfficeRepository(alternate);
   assert.equal((await restarted.getProject(project.id))?.id,project.id);
   assert.ok((await restarted.listTasks(project.id)).some(t=>t.id===task.id));
   assert.ok((await restarted.listEvents(project.id)).some(e=>e.eventId===first[0]!.eventId));
 }finally{await alternate.end();}
});

test('S04 rejects tasks linked to an office from another project atomically',{skip:!connection},async()=>{
 const repo=requireRepo(),ownerId=randomUUID();
 const a=await repo.createProject({ownerId,name:'Scope A',repositoryRoot:null,template:'startup'});
 const b=await repo.createProject({ownerId,name:'Scope B',repositoryRoot:null,template:'accounting'});
 const beforeTasks=(await repo.listTasks(a.project.id)).length;
 const beforeEvents=(await repo.listEvents(a.project.id)).length;
 await assert.rejects(repo.createTask({
   projectId:a.project.id,officeId:b.office.id,requestedBy:ownerId,
   title:'Cross-project task',description:'must rollback'
 }),(error:unknown)=> (error as {code?:string}).code==='23503');
 assert.equal((await repo.listTasks(a.project.id)).length,beforeTasks);
 assert.equal((await repo.listEvents(a.project.id)).length,beforeEvents);
});

test('S04 events are immutable, version and status constrained by PostgreSQL',{skip:!connection},async()=>{
 const repo=requireRepo(),ownerId=randomUUID();
 const p=await repo.createProject({ownerId,name:'Immutable',repositoryRoot:null,template:'custom'});
 const task=await repo.createTask({projectId:p.project.id,officeId:p.office.id,requestedBy:ownerId,title:'Audit log',description:'protected'});
 const e=(await repo.listEvents(p.project.id))[0]!;
 await assert.rejects(pool!.query('UPDATE task_events SET type=$1 WHERE event_id=$2',['artifact.recorded',e.eventId]),/append-only/);
 await assert.rejects(pool!.query('DELETE FROM task_events WHERE event_id=$1',[e.eventId]),/append-only/);
 await assert.rejects(pool!.query('UPDATE tasks SET status=$1 WHERE id=$2',['invalid_state',task.id]),(error:unknown)=> (error as {code?:string}).code==='23514');
 assert.equal((await repo.listEvents(p.project.id)).length,1);
});

test('S04 rejected invalid task input leaves no records',{skip:!connection},async()=>{
 const repo=requireRepo(),ownerId=randomUUID();
 const {project,office}=await repo.createProject({ownerId,name:'Rejected inputs',repositoryRoot:null,template:'startup'});
 await assert.rejects(repo.createTask({projectId:project.id,officeId:office.id,requestedBy:ownerId,title:' ',description:''}));
 assert.deepEqual(await repo.listTasks(project.id),[]);
 assert.deepEqual(await repo.listEvents(project.id),[]);
});
