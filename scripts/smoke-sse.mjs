import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {TokenStore} from '../dist/packages/db/src/tokens.js';

if(!process.env.DATABASE_URL){
 console.log('SKIP: compiled SSE smoke requires DATABASE_URL');
}else{
 const pool=createPool(process.env.DATABASE_URL);
 const tcp=createServer();
 await new Promise((resolve,reject)=>{tcp.once('error',reject);tcp.listen(0,'127.0.0.1',resolve);});
 const port=tcp.address().port;await new Promise(resolve=>tcp.close(resolve));
 const host='http://127.0.0.1:'+port;
 const owner=randomUUID(),repository=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool);
 const {project,office}=await repository.createProject({ownerId:owner,name:'S08 compiled '+randomUUID(),repositoryRoot:null,template:'custom'});
 const {project:other}=await repository.createProject({ownerId:owner,name:'S08 other '+randomUUID(),repositoryRoot:null,template:'custom'});
 const credential=await tokens.provision({projectId:project.id,subjectId:owner,kind:'integration',scopes:['events:read'],expiresInHours:2});
 const path='/v1/projects/'+project.id+'/stream';
 let proc,stderr='';
 async function start(){
  stderr='';
  proc=spawn(process.execPath,['dist/apps/api/src/main.js'],{
   cwd:process.cwd(),env:{...process.env,OMNYA_HOST:'127.0.0.1',OMNYA_PORT:String(port)},
   stdio:['ignore','ignore','pipe'],windowsHide:true
  });
  proc.stderr.on('data',x=>stderr+=String(x));
  for(let i=0;i<95;i++){
   if(proc.exitCode!==null)throw Error('API exited on startup: '+stderr.slice(-300));
   try{
    const response=await fetch(host+'/v1/status');
    if(response.status===200)return;
   }catch{/* API startup may still be in progress. */}
   await delay(90);
  }
  throw Error('Timed out waiting for compiled API '+stderr.slice(-250));
 }
 async function stop(){
  if(!proc)return;
  const active=proc;proc=undefined;
  if(active.exitCode!==null)return;
  const ended=new Promise(resolve=>active.once('exit',resolve));
  active.kill();
  if(!(await Promise.race([ended.then(()=>true),delay(5000).then(()=>false)])))throw Error('Failed to stop API');
 }
 const task=title=>repository.createTask({projectId:project.id,officeId:office.id,requestedBy:owner,title,description:''});
 async function stream(cursor){
  const controller=new AbortController();
  const response=await fetch(host+path,{headers:{
   authorization:'Bearer '+credential.secret,...(cursor===undefined?{}:{'last-event-id':String(cursor)})
  },signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',pending=[];
  return {
   async events(n){
    const result=[];
    const deadline=Date.now()+7000;
    while(result.length<n){
     while(pending.length&&result.length<n)result.push(pending.shift());
     if(result.length>=n)break;
     if(Date.now()>deadline)throw Error('SSE read timeout');
     const safety=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
     const chunk=await reader.read().finally(()=>clearTimeout(safety));
     if(chunk.done)throw Error('Unexpected SSE disconnect');
     buffer+=decoder.decode(chunk.value,{stream:true});
     let end;
     while((end=buffer.indexOf('\n\n'))>=0){
      const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
      if(!frame.includes('data: '))continue;
      const payload=frame.split('\n').find(x=>x.startsWith('data: '));
      const header=frame.split('\n').find(x=>x.startsWith('id: '));
      const value=JSON.parse(payload.slice(6));
      assert.equal(Number(header.slice(4)),value.id);
      pending.push(value);
     }
    }
    return result;
   },
   close(){controller.abort();}
  };
 }
 const checks=[];
 const ok=label=>checks.push(label);
 try{
  await start();ok('compiled-API-started');
  const unauth=await fetch(host+path);assert.equal(unauth.status,401);ok('unauthenticated-401');
  const cross=await fetch(host+'/v1/projects/'+other.id+'/stream',{
   headers:{authorization:'Bearer '+credential.secret}});
  assert.equal(cross.status,404);ok('cross-project-404');
  await task('preexisting');
  const first=await stream();
  let firstId;
  try{
   const received=await first.events(1);
   firstId=received[0].id;assert.equal(received[0].event.type,'task.created');
   await task('arrives-live');
   const live=await first.events(1);
   assert.ok(live[0].id>firstId);firstId=live[0].id;
  }finally{first.close();}
  ok('history-and-live-without-duplicates');
  await task('created-while-disconnected');
  await stop();ok('first-API-process-stopped');
  await start();ok('new-API-process-started');
  const resumed=await stream(firstId);
  let latest;
  try{
   const recovered=await resumed.events(1);
   assert.ok(recovered[0].id>firstId);
   latest=recovered[0].id;
   await task('created-after-reconnect');
   const live=await resumed.events(1);
   assert.ok(live[0].id>latest);
   latest=live[0].id;
  }finally{resumed.close();}
  ok('replay-after-API-restart-and-live');
  const after=await fetch(host+'/v1/projects/'+project.id+'/outbox?after='+firstId,{
   headers:{authorization:'Bearer '+credential.secret}});
  assert.equal(after.status,200);
  const data=await after.json();
  assert.equal(data.messages.length,2);
  assert.equal(data.messages.at(-1).id,latest);
  ok('SSE-cursor-equals-persisted-outbox');
  await tokens.revoke(credential.id);
  assert.equal((await fetch(host+path,{headers:{authorization:'Bearer '+credential.secret}})).status,401);
  ok('revoked-token-denied-after-restart');
  await stop();
  assert.equal(checks.length,9);
  console.log('PASS: compiled SSE history, live, disconnect, restart, Last-Event-ID replay, isolation and token revocation (9/9)');
 }finally{
  await stop();
  await pool.end();
 }
}
