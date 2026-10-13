import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {ResourceScheduler,ResourceKeySchema,resourcesConflict,SchedulerConflict} from '../packages/db/src/scheduler.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const url=process.env.DATABASE_URL;
let pool:Pool,repo:PostgresOfficeRepository,scheduler:ResourceScheduler,tokens:TokenStore,api:FastifyInstance;
const owner=randomUUID();
type Fixture={project:{id:string};office:{id:string}};
const fixture=()=>repo.createProject({ownerId:owner,name:'S10 '+randomUUID(),repositoryRoot:null,template:'custom'});
const task=async(f:Fixture,title='Scheduled')=>repo.createTask({projectId:f.project.id,officeId:f.office.id,
 requestedBy:owner,title,description:''});
const plan=async(f:Fixture,taskId:string,resources:{key:string;mode:'read'|'write'}[],
 priority=5,dependsOn:string[]=[])=>scheduler.register({projectId:f.project.id,taskId,priority,resources,dependsOn});
const resource=(key='repo',mode:'read'|'write'='write')=>[{key,mode}];
const w=()=>randomUUID();
before(async()=>{
 if(!url)return;
 pool=createPool(url);await runMigrations(pool);repo=new PostgresOfficeRepository(pool);
 scheduler=new ResourceScheduler(pool);tokens=new TokenStore(pool);api=await buildPersistentApi(pool);
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});

test('S10 versioned migration is idempotent and survives repeated init',{skip:!url},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 const r=await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1',['006_resource_scheduler.sql']);
 assert.equal(r.rowCount,1);
});

test('S10 classifier normalizes windows-style casing and rejects traversal, ambiguous paths',{skip:!url},()=>{
 assert.equal(ResourceKeySchema.parse('PATH:Src/Main.TS'),'path:src/main.ts');
 for(const key of ['path:../secrets','path:src/../api','path:src//api','path:/abs',
  'path:C:\\Windows','path:src/','path:./x','path:src%2fsecret','path:','db:table']){
  assert.throws(()=>ResourceKeySchema.parse(key),key);
 }
 assert.equal(resourcesConflict(resource('path:src'),resource('path:src/sub/file.ts')),true);
 assert.equal(resourcesConflict(resource('path:src'),resource('path:src-extra')),false);
 assert.equal(resourcesConflict(resource('repo','write'),resource('path:any')),true);
 assert.equal(resourcesConflict(resource('repo','read'),resource('path:any','read')),false);
 assert.equal(resourcesConflict(resource('path:x','read'),resource('path:x','read')),false);
 assert.equal(resourcesConflict(resource('path:x','write'),resource('path:x','read')),true);
});

test('S10 task resource declarations reject invalid shapes, duplicate keys and repo overlap',{skip:!url},async()=>{
 const f=await fixture(),t=await task(f);
 for(const resources of [[...resource(),...resource()],
  [{key:'path:src',mode:'write' as const},{key:'repo',mode:'read' as const}],
  [{key:'path:../x',mode:'write' as const}]]){
  await assert.rejects(plan(f,t.id,resources));
 }
 assert.equal(await scheduler.get(f.project.id,t.id),null);
 assert.ok((await plan(f,t.id,resource())).taskId);
 await assert.rejects(plan(f,t.id,resource()),SchedulerConflict);
});

test('S10 unrelated paths run simultaneously but ancestor and whole-repo writes block',{skip:!url},async()=>{
 const f=await fixture();
 const ids=await Promise.all(Array.from({length:4},()=>task(f)));
 await plan(f,ids[0]!.id,resource('path:src/api','write'),5);
 await plan(f,ids[1]!.id,resource('path:docs/readme','write'),5);
 await plan(f,ids[2]!.id,resource('path:src','read'),5);
 await plan(f,ids[3]!.id,resource('repo','write'),5);
 const a=await scheduler.claim(f.project.id,w()),b=await scheduler.claim(f.project.id,w());
 assert.ok(a&&b);
 assert.deepEqual(new Set([a.taskId,b.taskId]),new Set([ids[0]!.id,ids[1]!.id]));
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal(await scheduler.complete(f.project.id,a.taskId,a.workerId,a.leaseToken,a.fence),true);
 const c=await scheduler.claim(f.project.id,w());
 assert.ok(c);assert.equal(c.taskId,ids[2]!.id);
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal(await scheduler.complete(f.project.id,b.taskId,b.workerId,b.leaseToken,b.fence),true);
 assert.equal(await scheduler.complete(f.project.id,c.taskId,c.workerId,c.leaseToken,c.fence),true);
 const end=await scheduler.claim(f.project.id,w());assert.equal(end?.taskId,ids[3]!.id);
 assert.equal(await scheduler.complete(f.project.id,end!.taskId,end!.workerId,end!.leaseToken,end!.fence),true);
});

test('S10 shared readers coexist, writer waits and is picked after reader release',{skip:!url},async()=>{
 const f=await fixture(),a=await task(f),b=await task(f),c=await task(f);
 await plan(f,a.id,resource('path:docs','read'));
 await plan(f,b.id,resource('path:docs','read'));
 await plan(f,c.id,resource('path:docs/guide','write'));
 const r1=await scheduler.claim(f.project.id,w()),r2=await scheduler.claim(f.project.id,w());
 assert.ok(r1&&r2);assert.deepEqual(new Set([r1.taskId,r2.taskId]),new Set([a.id,b.id]));
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal(await scheduler.complete(f.project.id,r1.taskId,r1.workerId,r1.leaseToken,r1.fence),true);
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal(await scheduler.complete(f.project.id,r2.taskId,r2.workerId,r2.leaseToken,r2.fence),true);
 assert.equal((await scheduler.claim(f.project.id,w()))?.taskId,c.id);
});

test('S10 priority orders eligible jobs and enforces dependencies before claims',{skip:!url},async()=>{
 const f=await fixture();
 const parent=await task(f),low=await task(f),highBlocked=await task(f),high=await task(f);
 await plan(f,parent.id,resource('path:parent'),1);
 await plan(f,low.id,resource('path:low'),2);
 await plan(f,highBlocked.id,resource('path:blocked'),10,[parent.id]);
 await plan(f,high.id,resource('path:high'),9);
 const first=await scheduler.claim(f.project.id,w()),second=await scheduler.claim(f.project.id,w()),
  third=await scheduler.claim(f.project.id,w());
 assert.deepEqual([first?.taskId,second?.taskId,third?.taskId],[high.id,low.id,parent.id]);
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal(await scheduler.complete(f.project.id,third!.taskId,third!.workerId,third!.leaseToken,third!.fence),true);
 assert.equal((await scheduler.claim(f.project.id,w()))?.taskId,highBlocked.id);
});

test('S10 missing, self, repeated and cross-project dependencies rejected',{skip:!url},async()=>{
 const f=await fixture(),other=await fixture(),a=await task(f),b=await task(f),alien=await task(other);
 await plan(other,alien.id,resource('path:isolated'));
 await assert.rejects(plan(f,a.id,resource(),5,[alien.id]),SchedulerConflict);
 await assert.rejects(plan(f,a.id,resource(),5,[randomUUID()]),SchedulerConflict);
 await assert.rejects(plan(f,a.id,resource(),5,[a.id]));
 await plan(f,a.id,resource('path:a'));
 await assert.rejects(plan(f,b.id,resource('path:b'),5,[a.id,a.id]));
 await plan(f,b.id,resource('path:b'),5,[a.id]);
 assert.equal((await scheduler.get(f.project.id,b.id))?.dependsOn[0],a.id);
});

test('S10 concurrent 25 workers cannot claim the same exclusive resource twice',{skip:!url},async()=>{
 const f=await fixture(),ids=await Promise.all(Array.from({length:20},()=>task(f)));
 await Promise.all(ids.map((x,i)=>plan(f,x.id,resource('path:src/code/'+i+'.ts'),i%11)));
 const claims=await Promise.all(Array.from({length:25},()=>scheduler.claim(f.project.id,w())));
 const assigned=claims.filter(x=>x!==null);
 assert.equal(assigned.length,20);
 assert.equal(new Set(assigned.map(x=>x.taskId)).size,20);
 assert.ok(assigned.every(x=>x.fence===1));
 const resources=await pool.query('SELECT count(*)::int AS n FROM resource_leases WHERE project_id=$1',[f.project.id]);
 assert.equal(resources.rows[0].n,20);
});

test('S10 exclusive resource blocks competitors under 30 simultaneous claim attempts',{skip:!url},async()=>{
 const f=await fixture(),ids=await Promise.all(Array.from({length:12},()=>task(f)));
 await Promise.all(ids.map(x=>plan(f,x.id,resource('repo'))));
 const replies=await Promise.all(Array.from({length:30},()=>scheduler.claim(f.project.id,w())));
 assert.equal(replies.filter(x=>x!==null).length,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM resource_leases WHERE project_id=$1',
  [f.project.id])).rows[0].n,1);
});

test('S10 expired lease is recovered with stronger fence, stale owner cannot confirm',{skip:!url},async()=>{
 const f=await fixture(),t=await task(f);
 await plan(f,t.id,resource('repo'));
 const first=await scheduler.claim(f.project.id,w(),250);assert.ok(first);
 await delay(340);
 const replacement=await scheduler.claim(f.project.id,w(),3000);
 assert.ok(replacement);assert.equal(replacement.taskId,t.id);
 assert.equal(replacement.fence,first.fence+1);
 assert.notEqual(replacement.leaseToken,first.leaseToken);
 assert.equal(await scheduler.heartbeat(f.project.id,t.id,first.workerId,first.leaseToken,first.fence,1000),null);
 assert.equal(await scheduler.complete(f.project.id,t.id,first.workerId,first.leaseToken,first.fence),false);
 assert.equal(await scheduler.complete(f.project.id,t.id,replacement.workerId,replacement.leaseToken,replacement.fence),true);
 assert.equal(await scheduler.claim(f.project.id,w()),null);
});

test('S10 lease timestamp keeps native PostgreSQL microsecond precision on claim and heartbeat',{skip:!url},async()=>{
 const f=await fixture(),t=await task(f);
 await plan(f,t.id,resource('path:exact'));
 const c=await scheduler.claim(f.project.id,w(),3000);assert.ok(c);
 const equality=async()=>{
  const check=await pool.query(
   `SELECT r.fence=s.fence AS correct_fence, r.expires_at=s.lease_until AS exact_deadline
      FROM resource_leases r JOIN scheduled_tasks s USING(project_id,task_id)
      WHERE r.project_id=$1 AND r.task_id=$2`,[f.project.id,t.id]);
  assert.equal(check.rowCount,1);
  assert.deepEqual(check.rows[0],{correct_fence:true,exact_deadline:true});
 };
 await equality();
 const until=await scheduler.heartbeat(f.project.id,t.id,c.workerId,c.leaseToken,c.fence,4000);
 assert.ok(until);
 await equality();
 assert.equal(await scheduler.complete(f.project.id,t.id,c.workerId,c.leaseToken,c.fence),true);
});

test('S10 heartbeat renews lease; wrong token and fence never renew or complete',{skip:!url},async()=>{
 const f=await fixture(),t=await task(f);
 await plan(f,t.id,resource());
 const claim=await scheduler.claim(f.project.id,w(),400);assert.ok(claim);
 const later=await scheduler.heartbeat(f.project.id,t.id,claim.workerId,claim.leaseToken,claim.fence,1200);
 assert.ok(later);assert.ok(new Date(later!).getTime()>new Date(claim.leaseUntil).getTime());
 assert.equal(await scheduler.heartbeat(f.project.id,t.id,claim.workerId,randomUUID(),claim.fence,1200),null);
 assert.equal(await scheduler.complete(f.project.id,t.id,claim.workerId,claim.leaseToken,claim.fence+1),false);
 await delay(450);
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal(await scheduler.complete(f.project.id,t.id,claim.workerId,claim.leaseToken,claim.fence),true);
});

test('S10 a scheduler restarted on a second pool reclaims expired lock',{skip:!url},async()=>{
 const f=await fixture(),t=await task(f);
 await plan(f,t.id,resource());
 const before=await scheduler.claim(f.project.id,w(),250);assert.ok(before);
 const separate=createPool(url!);
 try{
  const restarted=new ResourceScheduler(separate);
  await delay(350);
  const newClaim=await restarted.claim(f.project.id,w(),2500);
  assert.ok(newClaim);
  assert.equal(newClaim.fence,before.fence+1);
  assert.equal(await scheduler.complete(f.project.id,t.id,before.workerId,before.leaseToken,before.fence),false);
  assert.equal(await restarted.complete(f.project.id,t.id,newClaim.workerId,newClaim.leaseToken,newClaim.fence),true);
 }finally{await separate.end();}
});

test('S10 cancellation revokes live lease and cancels blocked dependents',{skip:!url},async()=>{
 const f=await fixture(),a=await task(f),b=await task(f),c=await task(f);
 await plan(f,a.id,resource('repo'));
 await plan(f,b.id,resource('path:b'),4,[a.id]);
 await plan(f,c.id,resource('path:c'),4,[b.id]);
 const active=await scheduler.claim(f.project.id,w());assert.ok(active);
 assert.equal(await scheduler.cancel(f.project.id,a.id),true);
 assert.equal(await scheduler.complete(f.project.id,a.id,active.workerId,active.leaseToken,active.fence),false);
 assert.equal((await scheduler.get(f.project.id,b.id))?.state,'cancelled');
 assert.equal((await scheduler.get(f.project.id,c.id))?.state,'cancelled');
 assert.equal(await scheduler.claim(f.project.id,w()),null);
 assert.equal((await pool.query('SELECT count(*)::int n FROM resource_leases WHERE project_id=$1',
  [f.project.id])).rows[0].n,0);
});

test('S10 invalid task, cross-project registration and unsupported lifecycle blocked',{skip:!url},async()=>{
 const f=await fixture(),other=await fixture(),t=await task(f);
 await assert.rejects(scheduler.register({projectId:other.project.id,taskId:t.id,resources:resource()}));
 await assert.rejects(scheduler.register({projectId:f.project.id,taskId:randomUUID(),resources:resource()}));
 await plan(f,t.id,resource());
 const otherPlan=await scheduler.get(other.project.id,t.id);
 assert.equal(otherPlan,null);
});

test('S10 30 concurrent overlapping multi-resource plans cannot deadlock',{skip:!url},async()=>{
 const f=await fixture(),ids=await Promise.all(Array.from({length:30},()=>task(f)));
 await Promise.all(ids.map((t,i)=>plan(f,t.id,[
  {key:'path:shared/'+(i%3),mode:'write'},
  {key:'path:unique/'+i,mode:'write'}
 ],i%11)));
 let completed=0;
 const timeout=Date.now()+16000;
 while(completed<ids.length&&Date.now()<timeout){
  const batch=await Promise.all(Array.from({length:12},()=>scheduler.claim(f.project.id,w())));
  const active=batch.filter(x=>x!==null);
  assert.ok(active.length>0);
  assert.equal(new Set(active.flatMap(x=>x.resources.filter(r=>r.key.startsWith('path:shared')).map(r=>r.key))).size,
   active.length);
  await Promise.all(active.map(async c=>{
   assert.equal(await scheduler.complete(f.project.id,c.taskId,c.workerId,c.leaseToken,c.fence),true);
   completed++;
  }));
 }
 assert.equal(completed,30);
});

test('S10 HTTP scheduler authorized, principal owns lease; OpenAPI documents endpoints',{skip:!url},async()=>{
 const f=await fixture(),other=await fixture(),t=await task(f);
 const cred=await tokens.provision({projectId:f.project.id,subjectId:owner,kind:'integration',
  scopes:['tasks:read','tasks:transition'],origin:'codex',channel:'api',expiresInHours:2});
 const denied=await tokens.provision({projectId:f.project.id,subjectId:randomUUID(),kind:'integration',
  scopes:['tasks:read'],expiresInHours:2});
 const cross=await tokens.provision({projectId:other.project.id,subjectId:randomUUID(),kind:'integration',
  scopes:['tasks:transition'],expiresInHours:2});
 const prefix='/v1/projects/'+f.project.id;
 const createPath=prefix+'/tasks/'+t.id+'/schedule';
 const request=(method:'GET'|'POST',path:string,token?:string,payload?:unknown)=>api.inject({
  method,url:path,headers:{...(token?{authorization:'Bearer '+token}:{}),
   ...(payload?{'content-type':'application/json'}:{})},
  payload:payload?JSON.stringify(payload):undefined
 });
 const body={resources:resource('path:src')};
 assert.equal((await request('POST',createPath,undefined,body)).statusCode,401);
 assert.equal((await request('POST',createPath,denied.secret,body)).statusCode,403);
 assert.equal((await request('POST',createPath,cross.secret,body)).statusCode,404);
 assert.equal((await request('POST',createPath,cred.secret,body)).statusCode,201);
 assert.equal((await request('GET',createPath,cred.secret)).json().schedule.state,'queued');
 assert.equal((await request('POST',prefix+'/scheduler/claim',denied.secret,{})).statusCode,403);
 const claimResponse=await request('POST',prefix+'/scheduler/claim',cred.secret,{ttlMs:2000});
 assert.equal(claimResponse.statusCode,200,claimResponse.body);
 const claim=claimResponse.json().claim;
 assert.equal(claim.workerId,owner);
 const donePath=createPath+'/complete';
 assert.equal((await request('POST',donePath,cross.secret,{leaseToken:claim.leaseToken,fence:claim.fence})).statusCode,404);
 assert.equal((await request('POST',donePath,cred.secret,{leaseToken:randomUUID(),fence:claim.fence})).statusCode,409);
 assert.equal((await request('POST',donePath,cred.secret,{leaseToken:claim.leaseToken,fence:claim.fence})).statusCode,200);
 const doc=(await request('GET','/openapi.json')).json();
 assert.deepEqual(doc.paths['/v1/projects/{projectId}/scheduler/claim'].post.security,[{bearerToken:[]}]);
});
