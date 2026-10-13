import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {TokenStore} from '../dist/packages/db/src/tokens.js';
if(!process.env.DATABASE_URL){
 console.log('SKIP: S11 compiled Git integration smoke requires DATABASE_URL');
}else{
 const pool=createPool(process.env.DATABASE_URL);
 const repo=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool);
 const root=mkdtempSync(join(tmpdir(),'omnyadesk-s11-smoke-')),work=join(root,'work'),
  bare=join(root,'integration.git');
 let api;
 function git(dir,...args){
  const p=spawnSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(p.status,0,String(p.stderr).slice(-160));return p.stdout.trim();
 }
 async function freePort(){
  const tcp=createServer();
  await new Promise((ok,no)=>{tcp.once('error',no);tcp.listen(0,'127.0.0.1',ok);});
  const port=tcp.address().port;await new Promise(ok=>tcp.close(ok));return port;
 }
 const port=await freePort(),url='http://127.0.0.1:'+port;
 const start=async()=>{
  api=spawn(process.execPath,['dist/apps/api/src/main.js'],{cwd:process.cwd(),windowsHide:true,
   env:{...process.env,OMNYA_HOST:'127.0.0.1',OMNYA_PORT:String(port)},
   stdio:['ignore','ignore','pipe']});
  let errors='';api.stderr.on('data',x=>errors+=String(x));
  for(let i=0;i<100;i++){
   if(api.exitCode!==null)throw Error('API unavailable: '+errors.slice(-180));
   try{if((await fetch(url+'/v1/status')).status===200)return;}catch{/* awaiting boot */}
   await delay(60);
  }
  throw Error('API boot timeout: '+errors.slice(-180));
 };
 const stop=async()=>{
  if(!api)return;const p=api;api=undefined;if(p.exitCode!==null)return;
  const exited=new Promise(resolve=>p.once('exit',resolve));p.kill();
  if(!(await Promise.race([exited.then(()=>true),delay(4500).then(()=>false)])))throw Error('API stop failed');
 };
 let checks=0;
 const passed=()=>{checks++;};
 try{
  mkdirSync(work);git(root,'init','--bare','--initial-branch=main',bare);
  git(work,'init','--initial-branch=main');
  git(work,'config','user.name','Smoke');git(work,'config','user.email','smoke@example.invalid');
  writeFileSync(join(work,'README.md'),'initial\n');
  git(work,'add','.');git(work,'commit','-m','initial');
  const base=git(work,'rev-parse','HEAD');
  git(work,'remote','add','origin',bare);git(work,'push','origin','main');
  const branch=(name,path)=>{
   git(work,'switch','-C',name,base);
   writeFileSync(join(work,path),name+'\n');
   git(work,'add','.');git(work,'commit','-m',name);
   const commit=git(work,'rev-parse','HEAD');
   git(work,'push','--force','origin','HEAD:refs/heads/'+name);
   return commit;
  };
  const a=branch('feature/smoke-a','a.md'),b=branch('feature/smoke-b','b.md');
  const user=randomUUID(),operator=randomUUID(),reviewer=randomUUID();
  const p=await repo.createProject({ownerId:user,name:'S11 API smoke '+randomUUID(),
   repositoryRoot:bare,template:'startup'});
  const projectId=p.project.id;
  const grant=async(subjectId,kind,scopes)=>{
   const x=await tokens.provision({projectId,subjectId,kind,scopes,expiresInHours:2});
   return x.secret;
  };
  const submit=await grant(user,'integration',['git:propose','tasks:read']);
  const exec=await grant(operator,'integration',['git:integrate','tasks:read']);
  const approve=await grant(reviewer,'human',['git:review','tasks:read']);
  const unauthorized=await grant(randomUUID(),'integration',['tasks:read']);
  const t1=await repo.createTask({projectId,officeId:p.office.id,requestedBy:user,title:'candidate a',description:''});
  const t2=await repo.createTask({projectId,officeId:p.office.id,requestedBy:user,title:'candidate b',description:''});
  const prefix='/v1/projects/'+projectId+'/git/integrations';
  const request=async(method,path,token,body)=>{
   const response=await fetch(url+path,{method,headers:{
    ...(token?{authorization:'Bearer '+token}:{}),
    ...(body!==undefined?{'content-type':'application/json'}:{})
   },body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   return {status:response.status,body:await response.json()};
  };
  await start();
  const add=(task,branchName,sha)=>({taskId:task.id,candidateRef:'refs/heads/'+branchName,candidateSha:sha,baseSha:base});
  assert.equal((await request('POST',prefix,undefined,add(t1,'feature/smoke-a',a))).status,401);passed();
  assert.equal((await request('POST',prefix,unauthorized,add(t1,'feature/smoke-a',a))).status,403);passed();
  const first=await request('POST',prefix,submit,add(t1,'feature/smoke-a',a));assert.equal(first.status,201);passed();
  const second=await request('POST',prefix,submit,add(t2,'feature/smoke-b',b));assert.equal(second.status,201);passed();
  const one=prefix+'/'+first.body.id,two=prefix+'/'+second.body.id;
  assert.equal((await request('POST',one+'/integrate',exec)).status,409);passed();
  const preparedA=await request('POST',one+'/prepare',exec);
  const preparedB=await request('POST',two+'/prepare',exec);
  assert.equal(preparedA.body.state,'ready');assert.equal(preparedB.body.state,'ready');passed();
  assert.equal((await request('POST',one+'/approve',exec,{reviewHash:preparedA.body.reviewHash})).status,403);passed();
  assert.equal((await request('POST',one+'/approve',approve,{reviewHash:'0'.repeat(64)})).status,409);passed();
  assert.equal((await request('POST',one+'/approve',approve,{reviewHash:preparedA.body.reviewHash})).status,200);
  assert.equal((await request('POST',two+'/approve',approve,{reviewHash:preparedB.body.reviewHash})).status,200);passed();
  assert.equal((await request('POST',one+'/integrate',exec)).body.state,'merged');passed();
  const stale=await request('POST',two+'/integrate',exec);
  assert.equal(stale.status,409);assert.equal(stale.body.state,'stale');passed();
  const next=await request('POST',two+'/prepare',exec);
  assert.equal(next.body.state,'ready');assert.notEqual(next.body.reviewHash,preparedB.body.reviewHash);passed();
  await stop();await start();
  assert.equal((await request('POST',two+'/integrate',exec)).status,409);passed();
  assert.equal((await request('POST',two+'/approve',approve,{reviewHash:next.body.reviewHash})).status,200);passed();
  assert.equal((await request('POST',two+'/integrate',exec)).body.state,'merged');passed();
  assert.equal(git(bare,'show','refs/heads/main:a.md'),'feature/smoke-a');
  assert.equal(git(bare,'show','refs/heads/main:b.md'),'feature/smoke-b');passed();
  const audit=await pool.query('SELECT action FROM git_integration_audit WHERE project_id=$1',[projectId]);
  assert.equal(audit.rows.filter(x=>x.action==='merged').length,2);passed();
  assert.equal(checks,17);
  console.log('PASS: compiled Git integration queue API, two clients, human-bound review, rejection, restart, stale recheck, atomic bare merge (17/17)');
 }finally{await stop();await pool.end();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
}
