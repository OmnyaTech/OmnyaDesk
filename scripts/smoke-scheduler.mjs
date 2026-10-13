import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {TokenStore} from '../dist/packages/db/src/tokens.js';

if(!process.env.DATABASE_URL){
 console.log('SKIP: compiled scheduler smoke requires DATABASE_URL');
}else{
 const pool=createPool(process.env.DATABASE_URL),repo=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool);
 const owner=randomUUID(),{project,office}=await repo.createProject({
  ownerId:owner,name:'S10 compiled scheduler '+randomUUID(),repositoryRoot:null,template:'custom'
 });
 const credential=await tokens.provision({projectId:project.id,subjectId:owner,kind:'integration',
  scopes:['tasks:read','tasks:transition'],expiresInHours:2,origin:'codex'});
 const tcp=createServer();await new Promise((yes,no)=>{tcp.once('error',no);tcp.listen(0,'127.0.0.1',yes);});
 const port=tcp.address().port;await new Promise(done=>tcp.close(done));
 const apiUrl='http://127.0.0.1:'+port;
 let proc,stderr='',checks=0;
 const checked=()=>checks++;
 async function start(){
  stderr='';
  proc=spawn(process.execPath,['dist/apps/api/src/main.js'],{cwd:process.cwd(),
   env:{...process.env,OMNYA_HOST:'127.0.0.1',OMNYA_PORT:String(port)},
   stdio:['ignore','ignore','pipe'],windowsHide:true});
  proc.stderr.on('data',x=>stderr+=String(x));
  for(let i=0;i<100;i++){
   if(proc.exitCode!==null)throw Error('API failed '+stderr.slice(-300));
   try{if((await fetch(apiUrl+'/v1/status')).status===200)return;}catch{/* Boot pending */}
   await delay(80);
  }
  throw Error('API startup timed out '+stderr.slice(-300));
 }
 async function stop(){
  if(!proc)return;
  const child=proc;proc=undefined;if(child.exitCode!==null)return;
  const exit=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  if(!(await Promise.race([exit.then(()=>true),delay(4500).then(()=>false)])))throw Error('API stop timeout');
 }
 async function request(method,path,body,secret=credential.secret){
  const response=await fetch(apiUrl+path,{method,headers:{
   authorization:'Bearer '+secret,...(body!==undefined?{'content-type':'application/json'}:{})
  },body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5500)});
  return {status:response.status,result:await response.json()};
 }
 const base='/v1/projects/'+project.id;
 const create=async(title)=>repo.createTask({
  projectId:project.id,officeId:office.id,requestedBy:owner,title,description:''
 });
 let ok=false;
 try{
  const a=await create('process crash A'),b=await create('process crash B'),c=await create('independent C');
  await start();
  assert.equal((await request('POST',base+'/tasks/'+a.id+'/schedule',{resources:[{key:'path:src',mode:'write'}]})).status,201);
  assert.equal((await request('POST',base+'/tasks/'+b.id+'/schedule',{resources:[{key:'path:src',mode:'write'}]})).status,201);
  assert.equal((await request('POST',base+'/tasks/'+c.id+'/schedule',{resources:[{key:'path:docs',mode:'read'}]})).status,201);
  checked();
  const isolated=spawnSync(process.execPath,['scripts/scheduler-probe.mjs',apiUrl,project.id],{
   cwd:process.cwd(),encoding:'utf8',windowsHide:true,timeout:12000,
   env:{...process.env,OMNYA_SCHEDULER_TEST_TOKEN:credential.secret,DATABASE_URL:''}});
  assert.equal(isolated.status,0,isolated.stderr);
  const first=JSON.parse(isolated.stdout.trim());
  assert.equal(first.taskId,a.id);assert.equal(first.fence,1);checked();
  const independent=await request('POST',base+'/scheduler/claim',{ttlMs:1500});
  assert.equal(independent.status,200);assert.equal(independent.result.claim.taskId,c.id);checked();
  assert.equal((await request('POST',base+'/scheduler/claim',{ttlMs:1500})).result.claim,null);checked();
  await stop();await delay(350);await start();checked();
  const recovery=await request('POST',base+'/scheduler/claim',{ttlMs:4000});
  assert.equal(recovery.status,200);const replacement=recovery.result.claim;
  assert.equal(replacement.taskId,a.id);assert.equal(replacement.fence,2);checked();
  const stale=await request('POST',base+'/tasks/'+a.id+'/schedule/complete',{
   leaseToken:first.leaseToken,fence:first.fence});
  assert.equal(stale.status,409);checked();
  const complete=await request('POST',base+'/tasks/'+a.id+'/schedule/complete',{
   leaseToken:replacement.leaseToken,fence:replacement.fence});
  assert.equal(complete.status,200);checked();
  const next=await request('POST',base+'/scheduler/claim',{ttlMs:4000});
  assert.equal(next.result.claim.taskId,b.id);checked();
  assert.equal((await request('GET',base+'/tasks/'+b.id+'/schedule')).result.schedule.state,'running');checked();
  assert.equal((await request('POST',base+'/tasks/'+b.id+'/schedule/complete',{
   leaseToken:next.result.claim.leaseToken,fence:next.result.claim.fence})).status,200);
  assert.equal((await request('POST',base+'/tasks/'+c.id+'/schedule/complete',{
   leaseToken:independent.result.claim.leaseToken,fence:independent.result.claim.fence})).status,200);
  checked();
  ok=true;
  console.log('PASS: compiled scheduler API, separate crashing claimant process, independent claims, restart, fencing and resource recovery (11/11)');
 }finally{await stop();await pool.end();if(!ok)console.error('S10 process-level smoke failed');}
}
