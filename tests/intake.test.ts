import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TaskIntakeService,IntakeUnauthorized} from '../packages/db/src/intake.ts';
import {TokenStore,type ClientOrigin,type IntakeChannel} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const url=process.env.DATABASE_URL;
let pool:Pool,repo:PostgresOfficeRepository,intake:TaskIntakeService,tokens:TokenStore,api:FastifyInstance;
const actorId=randomUUID();
type P={project:{id:string};office:{id:string}};
const project=()=>repo.createProject({ownerId:actorId,name:'S09 '+randomUUID(),repositoryRoot:null,template:'startup'});
const register=async(p:P,origin:ClientOrigin,channel:IntakeChannel='api',subjectId=actorId,scopes:('tasks:create'|'tasks:read'|'events:read')[]=['tasks:create','tasks:read','events:read'])=>{
 const credential=await tokens.provision({projectId:p.project.id,subjectId,kind:'integration',scopes,
   expiresInHours:24,origin,channel});
 const principal=await tokens.authenticate('Bearer '+credential.secret);
 assert.ok(principal);
 return {...credential,principal};
};
const body=(p:P,title='Single ingress')=>({officeId:p.office.id,title,description:'shared'});
const submit=async(p:P,secret:string,key:string,route:'intake'|'tasks'='intake',value=body(p))=>api.inject({
 method:'POST',url:'/v1/projects/'+p.project.id+'/'+route,
 headers:{authorization:'Bearer '+secret,'content-type':'application/json','idempotency-key':key},
 payload:JSON.stringify(value)
});
before(async()=>{
 if(!url)return;
 pool=createPool(url);await runMigrations(pool);repo=new PostgresOfficeRepository(pool);
 intake=new TaskIntakeService(pool);tokens=new TokenStore(pool);api=await buildPersistentApi(pool);
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});

test('S09 migration is versioned, idempotent and existing credentials have default origin',{skip:!url},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 const rows=await pool.query('SELECT name FROM schema_migrations WHERE name=$1',['005_canonical_intake.sql']);
 assert.equal(rows.rowCount,1);
 const old=await pool.query('SELECT client_origin,intake_channel FROM api_tokens WHERE client_origin=$1 LIMIT 1',['cli']);
 assert.ok(old.rowCount);
});

test('S09 origin registered per token persists actor, event, outbox and provenance atomically',{skip:!url},async()=>{
 for(const origin of ['chatgpt','desktop_commander','codex','vscode'] as const){
  const p=await project(),creds=await register(p,origin);
  const key=randomUUID(),res=await submit(p,creds.secret,key);
  assert.equal(res.statusCode,201,res.body);
  const json=res.json();assert.equal(json.replayed,false);
  assert.equal(json.origin,origin);assert.equal(json.channel,'api');
  assert.equal(json.actor.id,actorId);assert.equal(json.actor.kind,'integration');
  assert.equal(json.task.requestedBy,actorId);
  const stored=await pool.query('SELECT * FROM task_intake_requests WHERE task_id=$1',[json.task.id]);
  assert.equal(stored.rowCount,1);
  assert.equal(stored.rows[0].client_origin,origin);
  assert.equal(stored.rows[0].token_id,creds.id);
  const events=await repo.listEvents(p.project.id);
  assert.equal(events.length,1);assert.equal(events[0]!.source,'api');
  assert.deepEqual(events[0]!.actor,{kind:'integration',id:actorId});
  assert.equal(events[0]!.correlationId,key);
  const out=await pool.query('SELECT event_id FROM task_outbox WHERE event_id=$1',[json.eventId]);
  assert.equal(out.rowCount,1);
  const provenance=await api.inject({method:'GET',url:'/v1/projects/'+p.project.id+'/tasks/'+json.task.id+'/intake',
   headers:{authorization:'Bearer '+creds.secret}});
  assert.equal(provenance.statusCode,200);
  assert.equal(provenance.json().provenance.origin,origin);
 }
});

test('S09 30 concurrent HTTP retries on the same key create ONE task and event',{skip:!url},async()=>{
 const p=await project(),creds=await register(p,'codex'),key=randomUUID();
 const r=await Promise.all(Array.from({length:30},(_,i)=>submit(p,creds.secret,key,i%2?'tasks':'intake')));
 assert.equal(r.filter(x=>x.statusCode===201).length,1);
 assert.equal(r.filter(x=>x.statusCode===200).length,29);
 assert.equal(new Set(r.map(x=>x.json().task.id)).size,1);
 assert.equal(new Set(r.map(x=>x.json().eventId)).size,1);
 assert.equal((await repo.listTasks(p.project.id)).length,1);
 assert.equal((await repo.listEvents(p.project.id)).length,1);
 assert.equal(Number((await pool.query('SELECT count(*) FROM task_outbox WHERE project_id=$1',[p.project.id])).rows[0].count),1);
});

test('S09 same idempotency key with modified payload or registered origin returns 409',{skip:!url},async()=>{
 const p=await project(),subject=randomUUID(),a=await register(p,'chatgpt','api',subject);
 const b=await register(p,'vscode','api',subject),key=randomUUID();
 assert.equal((await submit(p,a.secret,key)).statusCode,201);
 assert.equal((await submit(p,a.secret,key,'intake',body(p,'Different'))).statusCode,409);
 assert.equal((await submit(p,b.secret,key)).statusCode,409);
 assert.equal((await repo.listTasks(p.project.id)).length,1);
});

test('S09 creates distinct tasks for distinct subjects or distinct keys',{skip:!url},async()=>{
 const p=await project(),key=randomUUID(),a=await register(p,'codex','api',randomUUID());
 const b=await register(p,'codex','api',randomUUID());
 const r=await Promise.all([
  submit(p,a.secret,key),submit(p,b.secret,key),submit(p,a.secret,randomUUID())
 ]);
 assert.deepEqual(r.map(x=>x.statusCode),[201,201,201]);
 assert.equal(new Set(r.map(x=>x.json().task.id)).size,3);
});

test('S09 no key or invalid UUID is rejected before writing any task',{skip:!url},async()=>{
 const p=await project(),cred=await register(p,'chatgpt');
 for(const key of [undefined,'bad-key','00000000-0000-0000-0000-000000000000']){
  const headers:Record<string,string>={authorization:'Bearer '+cred.secret,'content-type':'application/json'};
  if(key!==undefined)headers['idempotency-key']=key;
  const response=await api.inject({method:'POST',url:'/v1/projects/'+p.project.id+'/tasks',
   headers,payload:JSON.stringify(body(p))});
  assert.equal(response.statusCode,400);
 }
 assert.deepEqual(await repo.listTasks(p.project.id),[]);
});

test('S09 untrusted body cannot forge actor, source, origin or channel',{skip:!url},async()=>{
 const p=await project(),cred=await register(p,'desktop_commander');
 for(const extra of [
  {origin:'codex'},{channel:'mcp'},{actorId:randomUUID()},{requestedBy:randomUUID()},
  {source:'mcp'},{projectId:randomUUID()}
 ]){
  const response=await submit(p,cred.secret,randomUUID(),'intake',{...body(p),...extra});
  assert.equal(response.statusCode,400,response.body);
 }
 assert.equal((await repo.listTasks(p.project.id)).length,0);
});

test('S09 project/scope boundaries: 401/403/404 and no read/write leakage',{skip:!url},async()=>{
 const p=await project(),other=await project(),allowed=await register(p,'codex');
 const read=await register(p,'vscode','api',randomUUID(),['tasks:read']);
 const another=await register(other,'chatgpt');
 const path='/v1/projects/'+p.project.id+'/intake';
 assert.equal((await api.inject({method:'POST',url:path,headers:{'idempotency-key':randomUUID(),
  'content-type':'application/json'},payload:JSON.stringify(body(p))})).statusCode,401);
 assert.equal((await submit(p,read.secret,randomUUID())).statusCode,403);
 assert.equal((await submit(p,another.secret,randomUUID())).statusCode,404);
 const created=await submit(p,allowed.secret,randomUUID());
 assert.equal(created.statusCode,201);
 const route='/v1/projects/'+p.project.id+'/tasks/'+created.json().task.id+'/intake';
 assert.equal((await api.inject({method:'GET',url:route,headers:{authorization:'Bearer '+another.secret}})).statusCode,404);
 assert.equal((await api.inject({method:'GET',url:route,headers:{authorization:'Bearer '+read.secret}})).statusCode,200);
});

test('S09 bad office FK rolls back request, event and task',{skip:!url},async()=>{
 const p=await project(),other=await project(),cred=await register(p,'codex'),key=randomUUID();
 const res=await submit(p,cred.secret,key,'intake',{officeId:other.office.id,title:'cross',description:''});
 assert.equal(res.statusCode,409);
 assert.equal((await repo.listTasks(p.project.id)).length,0);
 assert.equal((await repo.listEvents(p.project.id)).length,0);
 const rows=await pool.query('SELECT * FROM task_intake_requests WHERE idempotency_key=$1',[key]);
 assert.equal(rows.rowCount,0);
});

test('S09 invalidated token cannot be used by cached principal in service',{skip:!url},async()=>{
 const p=await project(),creds=await register(p,'chatgpt');
 await tokens.revoke(creds.id);
 await assert.rejects(intake.create({...body(p),projectId:p.project.id,idempotencyKey:randomUUID()},creds.principal),IntakeUnauthorized);
});

test('S09 receipt is identical after pool reconnect / service restart',{skip:!url},async()=>{
 const p=await project(),cred=await register(p,'codex'),key=randomUUID();
 const first=await submit(p,cred.secret,key);
 assert.equal(first.statusCode,201);
 const other=createPool(url!);
 try{
  const restored=new TaskIntakeService(other);
  const replay=await restored.create({...body(p),projectId:p.project.id,idempotencyKey:key},cred.principal);
  assert.equal(replay.replayed,true);
  assert.deepEqual({...replay,replayed:false},first.json());
 }finally{await other.end();}
});

test('S09 MCP-associated token records mcp provenance without trusting HTTP body',{skip:!url},async()=>{
 const p=await project(),creds=await register(p,'desktop_commander','mcp');
 const response=await submit(p,creds.secret,randomUUID());
 assert.equal(response.statusCode,201);
 assert.equal(response.json().channel,'mcp');
 const events=await repo.listEvents(p.project.id);
 assert.equal(events[0]?.source,'mcp');
});

test('S09 OpenAPI advertises both canonical and compatibility routes requiring Idempotency-Key',{skip:!url},async()=>{
 const response=await api.inject({method:'GET',url:'/openapi.json'});
 assert.equal(response.statusCode,200);
 const doc=response.json();
 for(const path of ['/v1/projects/{projectId}/intake','/v1/projects/{projectId}/tasks']){
  assert.deepEqual(doc.paths[path].post.security,[{bearerToken:[]}]);
  assert.ok(doc.paths[path].post.parameters.some((p:{name:string})=>p.name==='idempotency-key'));
 }
});
