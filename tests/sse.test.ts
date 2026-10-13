import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';
import {parseSseCursor,SSE_MAX_CLIENTS} from '../apps/api/src/sse.ts';
import {ReplayCursor,type StreamMessage} from '../packages/core/src/replay-cursor.ts';

const database=process.env.DATABASE_URL;
let pool:Pool,api:FastifyInstance,repo:PostgresOfficeRepository,tokens:TokenStore,base:string;
const owner=randomUUID();
type OfficeContext={project:{id:string};office:{id:string}};
const newProject=async()=>repo.createProject({ownerId:owner,name:'S08 streaming '+randomUUID(),
 repositoryRoot:null,template:'custom'});
const createTask=async(p:OfficeContext,title:string)=>{
 const task=await repo.createTask({projectId:p.project.id,officeId:p.office.id,
  requestedBy:owner,title,description:''});
 return task;
};
const issue=async(p:OfficeContext,scopes:('events:read'|'tasks:read')[]=['events:read'])=>
 tokens.provision({projectId:p.project.id,subjectId:owner,kind:'human',scopes,expiresInHours:8});

type Stream={response:Response;controller:AbortController;read:(n:number,ms?:number)=>Promise<StreamMessage[]>;waitEnd:()=>Promise<void>;close:()=>void};
const open=async(p:OfficeContext,secret:string,opts:{after?:number;lastId?:string;signal?:AbortSignal}={}):Promise<Stream>=>{
 const controller=new AbortController();
 const query=opts.after===undefined?'':'?after='+opts.after;
 const response=await fetch(base+'/v1/projects/'+p.project.id+'/stream'+query,{
  headers:{authorization:'Bearer '+secret,...(opts.lastId===undefined?{}:{'last-event-id':opts.lastId})},
  signal:opts.signal??controller.signal
 });
 if(response.status!==200)throw Error('stream status '+response.status);
 assert.match(response.headers.get('content-type')??'',/text\/event-stream/);
 const reader=response.body!.getReader(),decoder=new TextDecoder();
 let carry='';const waiting:StreamMessage[]=[];
 const read=async(n:number,ms=6500)=>{
  const collected:StreamMessage[]=[];
  const end=Date.now()+ms;
  while(collected.length<n){
   while(waiting.length&&collected.length<n)collected.push(waiting.shift()!);
   if(collected.length>=n)break;
   if(Date.now()>end)throw Error('SSE wait timed out');
   const timeout=AbortSignal.timeout(Math.max(1,end-Date.now()));
   const abort=()=>controller.abort();
   timeout.addEventListener('abort',abort,{once:true});
   let chunk:ReadableStreamReadResult<Uint8Array>;
   try{chunk=await reader.read();}finally{timeout.removeEventListener('abort',abort);}
   if(chunk.done)throw Error('SSE closed before expected messages');
   carry+=decoder.decode(chunk.value,{stream:true});
   let endIndex:number;
   while((endIndex=carry.indexOf('\n\n'))>=0){
    const frame=carry.slice(0,endIndex);carry=carry.slice(endIndex+2);
    if(frame.startsWith(':')||!frame.includes('data: '))continue;
    const idLine=frame.split('\n').find(line=>line.startsWith('id: '));
    const bodyLine=frame.split('\n').find(line=>line.startsWith('data: '));
    assert.ok(idLine&&bodyLine);
    const parsed=JSON.parse(bodyLine.slice(6)) as StreamMessage;
    assert.equal(parsed.id,Number(idLine.slice(4)));
    waiting.push(parsed);
   }
  }
  return collected;
 };
 const waitEnd=async()=>{
  const result=await Promise.race([
   reader.read(),
   delay(3500).then(()=>{throw Error('Active SSE was not closed after token revocation');})
  ]);
  assert.equal(result.done,true);
 };
 return {response,controller,read,waitEnd,close:()=>controller.abort()};
};
before(async()=>{
 if(!database)return;
 pool=createPool(database);await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);tokens=new TokenStore(pool);
 api=await buildPersistentApi(pool);
 const address=await api.listen({host:'127.0.0.1',port:0});
 base=address;
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});

test('S08 cursor rejects invalid or unsafe Last-Event-ID and accepts zero',{skip:!database},()=>{
 assert.equal(parseSseCursor(undefined),0);
 assert.equal(parseSseCursor('0'),0);
 assert.equal(parseSseCursor('42',10),42);
 assert.equal(parseSseCursor(undefined,100),100);
 for(const invalid of ['-1','1.5','Infinity','9007199254740992','garbage',' 2','','+2']){
  assert.throws(()=>parseSseCursor(invalid));
 }
});

test('S08 stream requires bearer, scope and same project even with Last-Event-ID',{skip:!database},async()=>{
 const a=await newProject(),b=await newProject();
 const read=await issue(a),wrong=await issue(a,['tasks:read']);
 const path='/v1/projects/'+a.project.id+'/stream';
 assert.equal((await fetch(base+path)).status,401);
 assert.equal((await fetch(base+path,{headers:{authorization:'Bearer '+wrong.secret}})).status,403);
 assert.equal((await fetch(base+'/v1/projects/'+b.project.id+'/stream',{
  headers:{authorization:'Bearer '+read.secret}})).status,404);
 for(const invalid of ['-1','foo','9007199254740992']){
  assert.equal((await fetch(base+path,{
   headers:{authorization:'Bearer '+read.secret,'last-event-id':invalid}})).status,400);
 }
 assert.equal((await fetch(base+path+'?after=-1',{headers:{authorization:'Bearer '+read.secret}})).status,400);
});

test('S08 rehydrates existing event history with strictly increasing unique IDs',{skip:!database},async()=>{
 const p=await newProject(),{secret}=await issue(p);
 await Promise.all(Array.from({length:13},(_,i)=>createTask(p,'history '+i)));
 const stream=await open(p,secret);
 try{
  const values=await stream.read(13);
  assert.equal(values.length,13);
  assert.equal(new Set(values.map(x=>x.id)).size,13);
  assert.deepEqual(values.map(x=>x.id),values.map(x=>x.id).sort((a,b)=>a-b));
  assert.ok(values.every(x=>x.event.projectId===p.project.id));
  const last=values.at(-1)!.id;
  const checkpoint=new ReplayCursor(p.project.id);
  assert.equal(values.filter(x=>checkpoint.ingest(x)).length,13);
  assert.equal(checkpoint.value(),last);
  assert.equal(checkpoint.ingest(values[0]!),false);
  assert.equal(checkpoint.ingest(values.at(-1)!),false);
 }finally{stream.close();}
});

test('S08 receives new events while connected and reconnects without loss or duplicate',{skip:!database},async()=>{
 const p=await newProject(),{secret}=await issue(p);
 const first=await open(p,secret);
 let previous:StreamMessage[];
 try{
  await createTask(p,'first live');
  previous=await first.read(1);
 }finally{first.close();}
 await Promise.all(['second','third','fourth'].map(x=>createTask(p,x)));
 const next=await open(p,secret,{lastId:String(previous![0]!.id)});
 try{
  const remaining=await next.read(3);
  const last=new ReplayCursor(p.project.id,previous![0]!.id);
  assert.equal(remaining.filter(m=>last.ingest(m)).length,3);
  assert.ok(remaining.every(x=>x.id>previous![0]!.id));
  assert.equal(new Set([previous![0]!.id,...remaining.map(x=>x.id)]).size,4);
  await createTask(p,'fifth live after replay');
  const live=await next.read(1);
  assert.ok(last.ingest(live[0]!));
  assert.equal(last.ingest(remaining[0]!),false);
  assert.equal(last.value(),live[0]!.id);
 }finally{next.close();}
});

test('S08 URL after cursor resumes and Last-Event-ID takes precedence',{skip:!database},async()=>{
 const p=await newProject(),{secret}=await issue(p);
 for(let i=0;i<3;i++)await createTask(p,'cursor '+i);
 const original=await open(p,secret);
 let all:StreamMessage[];
 try{all=await original.read(3);}finally{original.close();}
 const resumed=await open(p,secret,{after:all[0]!.id});
 try{
  assert.deepEqual((await resumed.read(2)).map(x=>x.id),all.slice(1).map(x=>x.id));
 }finally{resumed.close();}
 const header=await open(p,secret,{after:all[0]!.id,lastId:String(all[1]!.id)});
 try{assert.deepEqual((await header.read(1)).map(x=>x.id),[all[2]!.id]);}finally{header.close();}
});

test('S08 16 concurrent streams are bounded, 17th rejected and capacity recovered',{skip:!database},async()=>{
 const p=await newProject(),{secret}=await issue(p);
 const all:Stream[]=[];
 try{
  for(let i=0;i<SSE_MAX_CLIENTS;i++)all.push(await open(p,secret));
  const blocked=await fetch(base+'/v1/projects/'+p.project.id+'/stream',{
   headers:{authorization:'Bearer '+secret}});
  assert.equal(blocked.status,503);
 }finally{for(const client of all)client.close();}
 await delay(300);
 const again=await open(p,secret);
 again.close();
});

test('S08 drains more than 500 events across outbox pages without gaps',{skip:!database},async()=>{
 const p=await newProject(),{secret}=await issue(p);
 await Promise.all(Array.from({length:515},(_,i)=>createTask(p,'page '+i)));
 const all=await open(p,secret);
 try{
  const recovered=await all.read(515,30000);
  assert.equal(recovered.length,515);
  assert.equal(new Set(recovered.map(x=>x.id)).size,515);
  for(let i=1;i<recovered.length;i++)assert.ok(recovered[i]!.id>recovered[i-1]!.id);
  const after=await open(p,secret,{lastId:String(recovered[499]!.id)});
  try{
   const tail=await after.read(15,7500);
   assert.deepEqual(tail.map(x=>x.id),recovered.slice(500).map(x=>x.id));
  }finally{after.close();}
 }finally{all.close();}
});

test('S08 token revocation closes active stream and new connection is denied',{skip:!database},async()=>{
 const p=await newProject(),credential=await issue(p);
 const stream=await open(p,credential.secret);
 try{
  await createTask(p,'before revocation');
  assert.equal((await stream.read(1)).length,1);
  await tokens.revoke(credential.id);
  await stream.waitEnd();
  const denied=await fetch(base+'/v1/projects/'+p.project.id+'/stream',{
   headers:{authorization:'Bearer '+credential.secret}});
  assert.equal(denied.status,401);
 }finally{stream.close();}
});

test('S08 OpenAPI describes authenticated stream with project scope',{skip:!database},async()=>{
 const doc=await fetch(base+'/openapi.json').then(r=>r.json());
 const path=doc.paths['/v1/projects/{projectId}/stream'].get;
 assert.deepEqual(path.security,[{bearerToken:[]}]);
 assert.ok(path.parameters?.some((x:{name:string})=>x.name==='projectId'));
});
