import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const url=process.env.DATABASE_URL;
let pool:Pool,api:FastifyInstance,repo:PostgresOfficeRepository,tokens:TokenStore;
const owner=randomUUID();
let a:{project:{id:string};office:{id:string}},b:{project:{id:string};office:{id:string}};
let readToken:string,writerToken:string,otherToken:string,humanToken:string,writerId:string;
const token=async(projectId:string,scopes:('projects:read'|'tasks:read'|'tasks:create'|'tasks:transition'|'events:read')[],kind:'human'|'integration'='integration',subjectId=randomUUID())=>{
 const t=await tokens.provision({projectId,subjectId,kind,scopes,expiresInHours:24});
 return {...t,subjectId};
};
const call=async(method:'GET'|'POST',path:string,secret?:string,body?:unknown)=>
 api.inject({method,url:path,headers:{...(secret?{authorization:'Bearer '+secret}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...(method==='POST'&&path.endsWith('/tasks')?{'idempotency-key':randomUUID()}:{})},
  payload:body===undefined?undefined:JSON.stringify(body)});
before(async()=>{
 if(!url)return;
 pool=createPool(url);await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);tokens=new TokenStore(pool);
 a=await repo.createProject({ownerId:owner,name:'S07 tenant A '+randomUUID(),repositoryRoot:null,template:'startup'});
 b=await repo.createProject({ownerId:owner,name:'S07 tenant B '+randomUUID(),repositoryRoot:null,template:'accounting'});
 const read=await token(a.project.id,['projects:read','tasks:read','events:read']);
 const writer=await token(a.project.id,['tasks:read','tasks:create','tasks:transition','events:read']);
 const other=await token(b.project.id,['projects:read','tasks:read','tasks:create','tasks:transition','events:read']);
 const human=await token(a.project.id,['tasks:transition'],'human');
 readToken=read.secret;writerToken=writer.secret;writerId=writer.subjectId;
 otherToken=other.secret;humanToken=human.secret;
 api=await buildPersistentApi(pool);
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});

test('S07 bearer tokens stored as SHA256 only, never plaintext',{skip:!url},async()=>{
 const saved=await pool.query('SELECT secret_sha256,expires_at FROM api_tokens WHERE project_id=$1',[a.project.id]);
 assert.ok(saved.rowCount);
 assert.ok(saved.rows.every((row:{secret_sha256:string})=>/^[a-f0-9]{64}$/.test(row.secret_sha256)));
 assert.ok(saved.rows.every((row:{secret_sha256:string})=>!row.secret_sha256.includes('odt_')));
 assert.equal((await tokens.authenticate('Bearer '+readToken))?.projectId,a.project.id);
 assert.equal(await tokens.authenticate('Basic '+readToken),null);
 assert.equal(await tokens.authenticate('Bearer invalid'),null);
});

test('S07 Fastify serves generated OpenAPI 3 including bearer security and typed paths',{skip:!url},async()=>{
 const status=await call('GET','/v1/status');
 assert.equal(status.statusCode,200);
 const doc=await call('GET','/openapi.json');
 assert.equal(doc.statusCode,200);
 const openapi=doc.json();
 assert.match(openapi.openapi,/^3\./);
 assert.ok(openapi.paths['/v1/projects/{projectId}/tasks']);
 assert.deepEqual(openapi.paths['/v1/projects/{projectId}/tasks'].post.security,[{bearerToken:[]}]);
 assert.equal(openapi.components.securitySchemes.bearerToken.scheme,'bearer');
});

test('S07 all protected endpoints reject missing bearer (401)',{skip:!url},async()=>{
 for(const [method,path] of [
  ['GET','/v1/projects'],
  ['GET','/v1/projects/'+a.project.id],
  ['GET','/v1/projects/'+a.project.id+'/tasks'],
  ['POST','/v1/projects/'+a.project.id+'/tasks'],
  ['GET','/v1/projects/'+a.project.id+'/events'],
  ['GET','/v1/projects/'+a.project.id+'/outbox'],
  ['POST','/v1/projects/'+a.project.id+'/tasks/'+randomUUID()+'/transitions'],
 ]as const){
  const res=await call(method,path);
  assert.equal(res.statusCode,401,method+' '+path);
 }
});

test('S07 malformed, random and revoked tokens yield 401',{skip:!url},async()=>{
 const p='/v1/projects/'+a.project.id+'/tasks';
 for(const header of ['Bearer xyz','Basic '+readToken,'Bearer odt_'+'f'.repeat(64),'Bearer '+readToken+'extra']){
  const res=await api.inject({method:'GET',url:p,headers:{authorization:header}});
  assert.equal(res.statusCode,401);
 }
 const issued=await token(a.project.id,['tasks:read']);
 assert.equal((await call('GET',p,issued.secret)).statusCode,200);
 assert.equal(await tokens.revoke(issued.id),true);
 assert.equal(await tokens.revoke(issued.id),false);
 assert.equal((await call('GET',p,issued.secret)).statusCode,401);
});

test('S07 expired bearer rejects requests regardless of original scopes',{skip:!url},async()=>{
 const issued=await token(a.project.id,['tasks:read']);
 await pool.query('UPDATE api_tokens SET created_at=now()-interval \'2 days\',expires_at=now()-interval \'1 second\' WHERE id=$1',[issued.id]);
 assert.equal((await call('GET','/v1/projects/'+a.project.id+'/tasks',issued.secret)).statusCode,401);
});

test('S07 project list is scoped to bearer, never global',{skip:!url},async()=>{
 const res=await call('GET','/v1/projects',readToken);
 assert.equal(res.statusCode,200);
 assert.deepEqual(res.json().projects.map((p:{id:string})=>p.id),[a.project.id]);
 assert.equal((await call('GET','/v1/projects',writerToken)).statusCode,403);
});

test('S07 cross-project GET and POST denied (404 even if user knows UUID)',{skip:!url},async()=>{
 const scoped='/v1/projects/'+b.project.id;
 assert.equal((await call('GET',scoped+'/tasks',writerToken)).statusCode,404);
 assert.equal((await call('GET',scoped+'/events',writerToken)).statusCode,404);
 assert.equal((await call('GET',scoped+'/outbox',writerToken)).statusCode,404);
 assert.equal((await call('POST',scoped+'/tasks',writerToken,{
  officeId:b.office.id,title:'cross-tenant',description:'blocked'})).statusCode,404);
 assert.equal((await call('GET','/v1/projects/'+a.project.id,otherToken)).statusCode,404);
});

test('S07 readonly scope denies writes and transition, returns 403',{skip:!url},async()=>{
 const path='/v1/projects/'+a.project.id;
 const tasks=await call('GET',path+'/tasks',readToken);assert.equal(tasks.statusCode,200);
 assert.equal((await call('POST',path+'/tasks',readToken,{
  officeId:a.office.id,title:'no',description:''})).statusCode,403);
 assert.equal((await call('POST',path+'/tasks/'+randomUUID()+'/transitions',readToken,{
  commandKey:randomUUID(),expectedVersion:1,to:'queued',reason:null})).statusCode,403);
});

test('S07 authenticated task create binds requestedBy to token principal',{skip:!url},async()=>{
 const path='/v1/projects/'+a.project.id+'/tasks';
 const spoofed=await call('POST',path,writerToken,{
  officeId:a.office.id,title:'spoof attempt',description:'',requestedBy:randomUUID()});
 assert.equal(spoofed.statusCode,400);
 const result=await call('POST',path,writerToken,{
  officeId:a.office.id,title:'Authorized task',description:'token identifies requester'});
 assert.equal(result.statusCode,201);
 assert.equal(result.json().task.requestedBy,writerId);
 const events=await call('GET','/v1/projects/'+a.project.id+'/events',writerToken);
 assert.equal(events.statusCode,200);
 assert.ok(events.json().events.some((e:{taskId:string})=>e.taskId===result.json().task.id));
});

test('S07 invalid office FK cannot cross tenant even with tasks:create',{skip:!url},async()=>{
 const response=await call('POST','/v1/projects/'+a.project.id+'/tasks',writerToken,{
  officeId:b.office.id,title:'bad office',description:''});
 assert.equal(response.statusCode,409);
});

test('S07 task transition uses authenticated integration identity and scoped permissions',{skip:!url},async()=>{
 const c=await call('POST','/v1/projects/'+a.project.id+'/tasks',writerToken,{
  officeId:a.office.id,title:'Transition auth',description:''});
 assert.equal(c.statusCode,201);
 const id=c.json().task.id;
 const route='/v1/projects/'+a.project.id+'/tasks/'+id+'/transitions';
 const body={commandKey:randomUUID(),expectedVersion:1,to:'queued',reason:null};
 const transitioned=await call('POST',route,writerToken,body);
 assert.equal(transitioned.statusCode,200);
 assert.equal(transitioned.json().event.actor.kind,'integration');
 assert.equal(transitioned.json().event.actor.id,writerId);
 const replay=await call('POST',route,writerToken,body);
 assert.equal(replay.statusCode,200);assert.equal(replay.json().replayed,true);
 assert.equal((await call('POST',route,otherToken,body)).statusCode,404);
});

test('S07 no direct project creation and no legacy HTTP bypass in Fastify mode',{skip:!url},async()=>{
 assert.equal((await call('POST','/v1/projects',writerToken,{
  ownerId:randomUUID(),name:'unsafe',repositoryRoot:null,template:'startup'})).statusCode,404);
 assert.equal((await call('GET','/api/tasks')).statusCode,404);
 assert.equal((await call('POST','/api/tasks')).statusCode,404);
});

test('S07 approvals remain gated even with authenticated human until S15',{skip:!url},async()=>{
 const route='/v1/projects/'+a.project.id+'/tasks/'+randomUUID()+'/transitions';
 const body={commandKey:randomUUID(),expectedVersion:1,to:'approved',reason:null};
 assert.equal((await call('POST',route,humanToken,body)).statusCode,403);
 assert.equal((await call('POST',route,humanToken,{...body,to:'changes_requested'})).statusCode,403);
});

test('S07 strict request schema and cursor validation return 400 without leaks',{skip:!url},async()=>{
 const p='/v1/projects/'+a.project.id+'/tasks';
 assert.equal((await call('POST',p,writerToken,{officeId:a.office.id,title:'',description:''})).statusCode,400);
 assert.equal((await call('GET','/v1/projects/'+a.project.id+'/events?after=-1',writerToken)).statusCode,400);
 assert.equal((await call('GET','/v1/projects/'+a.project.id+'/outbox?after=hello',writerToken)).statusCode,400);
});
