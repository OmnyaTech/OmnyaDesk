import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {TokenStore} from '../dist/packages/db/src/tokens.js';

if(!process.env.DATABASE_URL){
 console.log('SKIP: S07 compiled Fastify smoke requires DATABASE_URL');
}else{
 const pool=createPool(process.env.DATABASE_URL);
 const socket=createServer();
 await new Promise((ok,fail)=>{socket.once('error',fail);socket.listen(0,'127.0.0.1',ok);});
 const port=socket.address().port;await new Promise(ok=>socket.close(ok));
 const base='http://127.0.0.1:'+port;
 const repo=new PostgresOfficeRepository(pool),tokenStore=new TokenStore(pool);
 const owner=randomUUID();
 let child,stderr='';
 const request=async(method,path,secret,body)=>{
  const res=await fetch(base+path,{method,headers:{
   ...(secret?{authorization:'Bearer '+secret}:{}),
   ...(body?{'content-type':'application/json'}:{}),
   ...(method==='POST'&&path.endsWith('/tasks')?{'idempotency-key':randomUUID()}:{})
  },body:body?JSON.stringify(body):undefined});
  return {status:res.status,value:await res.json()};
 };
 const start=async()=>{
  stderr='';
  child=spawn(process.execPath,['dist/apps/api/src/main.js'],{cwd:process.cwd(),
   env:{...process.env,OMNYA_HOST:'127.0.0.1',OMNYA_PORT:String(port)},
   stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',b=>stderr+=String(b));
  for(let i=0;i<90;i++){
   if(child.exitCode!==null)throw Error('API exited: '+stderr.slice(0,300));
   try{const r=await request('GET','/v1/status');if(r.status===200)return;}catch{/* Poll until the server starts listening. */}
   await delay(100);
  }
  throw Error('API startup timeout: '+stderr.slice(0,300));
 };
 const stop=async()=>{
  if(!child)return;const proc=child;child=undefined;
  if(proc.exitCode!==null)return;
  const exit=new Promise(resolve=>proc.once('exit',resolve));
  proc.kill();
  const done=await Promise.race([exit.then(()=>true),delay(4000).then(()=>false)]);
  if(!done)throw Error('API could not stop');
 };
 let good=false;
 try{
  const {project,office}=await repo.createProject({ownerId:owner,name:'S07 compiled '+randomUUID(),repositoryRoot:null,template:'startup'});
  const read=await tokenStore.provision({projectId:project.id,subjectId:owner,kind:'human',
   scopes:['projects:read','tasks:read'],expiresInHours:12});
  const write=await tokenStore.provision({projectId:project.id,subjectId:owner,kind:'integration',
   scopes:['tasks:read','tasks:create','tasks:transition','events:read'],expiresInHours:12});
  await start();
  assert.equal((await request('GET','/v1/projects')).status,401);
  assert.equal((await request('GET','/v1/projects',read.secret)).status,200);
  assert.equal((await request('POST','/v1/projects/'+project.id+'/tasks',read.secret,{
   officeId:office.id,title:'Unauthorized',description:''})).status,403);
  const created=await request('POST','/v1/projects/'+project.id+'/tasks',write.secret,{
   officeId:office.id,title:'S07 compiled smoke',description:''});
  assert.equal(created.status,201);assert.equal(created.value.task.requestedBy,owner);
  assert.equal((await request('GET','/api/tasks')).status,404);
  const doc=await request('GET','/openapi.json');
  assert.equal(doc.status,200);assert.ok(doc.value.paths['/v1/projects/{projectId}/tasks']);
  await stop();
  await start();
  assert.equal((await request('GET','/v1/projects/'+project.id+'/tasks',write.secret)).value.tasks.length,1);
  await tokenStore.revoke(write.id);
  assert.equal((await request('GET','/v1/projects/'+project.id+'/tasks',write.secret)).status,401);
  assert.equal((await request('GET','/v1/projects',read.secret)).status,200);
  await stop();
  const unsafe=spawnSync(process.execPath,['dist/apps/api/src/main.js'],{cwd:process.cwd(),
   env:{...process.env,OMNYA_HOST:'0.0.0.0',OMNYA_PORT:String(port)},
   encoding:'utf8',timeout:10000,windowsHide:true});
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stderr,/LOCAL ONLY/);
  good=true;
  console.log('PASS: compiled Fastify API 401/403, authorization, OpenAPI, no legacy bypass, token revocation after restart, loopback bind guard');
 }finally{
  await stop();
  await pool.end();
  if(!good)console.error('Compiled auth smoke failed');
 }
}
