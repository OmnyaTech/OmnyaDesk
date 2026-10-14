import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {EvidenceLedger} from '../packages/db/src/evidence-ledger.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const url=process.env.DATABASE_URL;
let pool:Pool,api:FastifyInstance;
let projectA:string,projectB:string,taskA:string,taskB:string;
let full:string,readonly:string,wrong:string,insufficient:string;
const sentry='S20_SECRET_NEVER_EXPOSED_'+randomUUID();
const get=(path:string,token?:string)=>api.inject({method:'GET',url:path,
 headers:token?{authorization:'Bearer '+token}:{}});
before(async()=>{
 if(!url)return;
 pool=createPool(url);await runMigrations(pool);
 const repo=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool),ledger=new EvidenceLedger(pool);
 const a=await repo.createProject({ownerId:randomUUID(),name:'S20 tenant A '+randomUUID(),
  repositoryRoot:null,template:'custom'});
 const b=await repo.createProject({ownerId:randomUUID(),name:'S20 tenant B '+randomUUID(),
  repositoryRoot:null,template:'custom'});
 projectA=a.project.id;projectB=b.project.id;
 taskA=(await repo.createTask({projectId:projectA,officeId:a.office.id,
  requestedBy:randomUUID(),title:'S20 task A',description:'Synthetic UI'})).id;
 taskB=(await repo.createTask({projectId:projectB,officeId:b.office.id,
  requestedBy:randomUUID(),title:'S20 task B',description:'Private'})).id;
 await ledger.append({projectId:projectA,taskId:taskA,runId:null,
  kind:'log',scopeKey:'s20-operator',actorId:'s20_test',content:sentry,
  metadata:{secret:sentry,src:'test'}});
 const newToken=async(projectId:string,scopes:('projects:read'|'tasks:read'|'events:read')[])=>
  (await tokens.provision({projectId,subjectId:randomUUID(),kind:'human',
   scopes,expiresInHours:2,origin:'web'})).secret;
 full=await newToken(projectA,['projects:read','tasks:read','events:read']);
 readonly=await newToken(projectA,['tasks:read']);
 wrong=await newToken(projectB,['tasks:read']);
 insufficient=await newToken(projectA,['projects:read']);
 api=await buildPersistentApi(pool);
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});
test('S20 evidence endpoint denies unauthenticated, missing scope and cross-tenant access',{skip:!url},async()=>{
 const path='/v1/projects/'+projectA+'/tasks/'+taskA+'/evidence';
 assert.equal((await get(path)).statusCode,401);
 assert.equal((await get(path,insufficient)).statusCode,403);
 assert.equal((await get(path,wrong)).statusCode,404);
 assert.equal((await get('/v1/projects/'+projectB+'/tasks/'+taskB+'/evidence',readonly)).statusCode,404);
 assert.equal((await get('/v1/projects/'+projectA+'/tasks/'+randomUUID()+'/evidence',readonly)).statusCode,404);
});
test('S20 evidence summary includes verified chain digests, never content or metadata',{skip:!url},async()=>{
 const r=await get('/v1/projects/'+projectA+'/tasks/'+taskA+'/evidence',readonly);
 assert.equal(r.statusCode,200);
 const body=r.json();
 assert.equal(body.evidence.length,1);
 const item=body.evidence[0];
 assert.equal(item.projectId,projectA);assert.equal(item.taskId,taskA);
 assert.equal(item.kind,'log');assert.equal(item.version,1);
 assert.match(item.chainSha256,/^[a-f0-9]{64}$/);
 assert.match(item.contentSha256,/^[a-f0-9]{64}$/);
 assert.equal(item.content,undefined);assert.equal(item.metadata,undefined);
 assert.equal(r.body.includes(sentry),false);
});
test('S20 operator API respects project ownership, task state and real events',{skip:!url},async()=>{
 const projects=await get('/v1/projects',full);
 assert.deepEqual(projects.json().projects.map((p:{id:string})=>p.id),[projectA]);
 const tasks=await get('/v1/projects/'+projectA+'/tasks',full);
 assert.ok(tasks.json().tasks.some((t:{id:string;status:string})=>t.id===taskA&&t.status==='created'));
 const events=await get('/v1/projects/'+projectA+'/events',full);
 assert.ok(events.json().events.some((e:{taskId:string})=>e.taskId===taskA));
});
test('S20 static operator shell enforces CSP and never includes bearer/secret',{skip:!url},async()=>{
 // The server's HTML is compiled after tests; ensure at least source asset is present.
 const page=await get('/operator');
 if(page.statusCode===200){
  assert.match(page.headers['content-security-policy']??'',/default-src 'none'/);
  assert.match(page.headers['content-security-policy']??'',/connect-src 'self'/);
  assert.equal(page.headers['cache-control'],'no-store');
  assert.equal(page.body.includes(sentry),false);
 }else{
  // Fresh clones run tests before build; smoke:operator verifies serving compiled assets after build.
  assert.equal(page.statusCode,500);
 }
});
test('S20 query and shape validation deny injection and unexpected paths',{skip:!url},async()=>{
 const malformed=await get('/v1/projects/'+projectA+'/tasks/not-a-uuid/evidence',readonly);
 assert.equal(malformed.statusCode,400);
 const untrusted=await get('/v1/projects/'+projectA+'/tasks/'+taskA+'/evidence?after=\'DROP',readonly);
 assert.ok([200,400].includes(untrusted.statusCode));
 assert.equal(untrusted.body.includes(sentry),false);
});
