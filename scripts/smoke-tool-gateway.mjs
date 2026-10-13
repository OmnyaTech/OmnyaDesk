import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {ResourceScheduler} from '../dist/packages/db/src/scheduler.js';
import {UbuntuSshTransport,quoteRemote} from '../dist/packages/db/src/remote-ubuntu.js';
import {RemoteWorktreeManager} from '../dist/packages/db/src/remote-worktrees.js';
import {UbuntuToolGateway,ToolRequestSchema} from '../dist/packages/db/src/tool-gateway.js';
const url=process.env.DATABASE_URL,config=process.env.OMNYA_S12_REMOTE_CONFIG;
if(!url||!config){
 if(process.env.OMNYA_S13_REQUIRED==='1')throw Error('S13 Ubuntu Server gateway smoke is required');
 console.log('SKIP: S13 compiled tool gateway requires DATABASE_URL and OMNYA_S12_REMOTE_CONFIG');
}else{
 const pool=createPool(url),repository=new PostgresOfficeRepository(pool),
  scheduler=new ResourceScheduler(pool),ssh=new UbuntuSshTransport(JSON.parse(readFileSync(config,'utf8'))),
  manager=new RemoteWorktreeManager(pool,ssh),gateway=new UbuntuToolGateway(pool,manager);
 const dir=mkdtempSync(join(tmpdir(),'omnyadesk-s13-smoke-')),
  source=join(dir,'source'),bare=join(dir,'source.git');
 mkdirSync(source);
 function git(root,...args){
  const p=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:12000});
  assert.equal(p.status,0,args.join(' ')+String(p.stderr).slice(-120));return p.stdout.trim();
 }
 let projectId,taskId,runId,claim,checkout,checks=0;
 const pass=()=>checks++;
 const hash=s=>createHash('sha256').update(s).digest('hex');
 try {
  await ssh.connect();
  git(dir,'init','--bare','--initial-branch=main',bare);
  git(source,'init','--initial-branch=main');git(source,'config','user.name','S13 QA');
  git(source,'config','user.email','s13@example.invalid');
  writeFileSync(join(source,'README.md'),'S13 baseline\n');
  writeFileSync(join(source,'entry.sh'),'#!/bin/sh\necho S13_SANDBOX_SMOKE_PASS\n');
  git(source,'add','.');git(source,'commit','-m','base');
  const sha=git(source,'rev-parse','HEAD');
  git(source,'remote','add','origin',bare);git(source,'push','origin','main');
  const project=await repository.createProject({ownerId:randomUUID(),name:'S13 compiled smoke '+randomUUID(),
   repositoryRoot:bare,template:'custom'});
  projectId=project.project.id;
  const t=await repository.createTask({projectId,officeId:project.office.id,requestedBy:randomUUID(),
   title:'S13 smoke '+randomUUID(),description:''});
  taskId=t.id;
  await scheduler.register({projectId,taskId,resources:[{key:'repo',mode:'write'}],priority:5,dependsOn:[]});
  claim=await scheduler.claim(projectId,'s13-compiled-'+randomUUID(),85000);
  assert.ok(claim);pass();
  const row=await manager.create({projectId,taskId,baseSha:sha});
  runId=row.runId;checkout=row.checkoutPath;
  assert.equal(row.executionBackend,'ubuntu_ssh_docker');pass();
  const request=(tool,props={})=>({projectId,taskId,runId,workerId:claim.workerId,
   leaseToken:claim.leaseToken,fence:claim.fence,tool,...props});
  assert.equal(ToolRequestSchema.safeParse(request('shell.exec',{command:'echo hi'})).success,false);pass();
  assert.equal(ToolRequestSchema.safeParse(request('files.read',{path:'../../etc/passwd'})).success,false);pass();
  assert.equal(ToolRequestSchema.safeParse(request('git.push')).success,false);pass();
  const read=await gateway.run(request('files.read',{path:'README.md'}));
  assert.equal(read.result.text,'S13 baseline\n');pass();
  const list=await gateway.run(request('files.list'));
  assert.ok(list.result.entries.some(x=>x.name==='README.md'));pass();
  const edit=await gateway.run(request('files.write',{path:'README.md',
   content:'S13 updated\n',expectedSha:hash('S13 baseline\n')}));
  assert.equal(edit.result.sha256,hash('S13 updated\n'));pass();
  const diff=await gateway.run(request('git.diff',{path:'README.md'}));
  assert.ok(diff.result.text.includes('S13 updated'));pass();
  const status=await gateway.run(request('git.status'));
  assert.ok(status.result.text.includes('README.md'));pass();
  await assert.rejects(gateway.run(request('files.write',{path:'README.md',
   content:'stale\n',expectedSha:hash('S13 baseline\n')})));pass();
  await assert.rejects(gateway.run(request('files.read',{path:'README.md',workerId:'intruder'})));pass();
  const run=await gateway.run(request('tests.run',{suite:'entry'}));
  assert.equal(run.success,true);assert.match(run.result.stdout,/S13_SANDBOX_SMOKE_PASS/);pass();
  assert.equal(await ssh.requireOk("docker ps -a --filter label=com.omnyadesk.sprint=S12 --format '{{.Names}}'"),'');pass();
  await ssh.requireOk('git -C '+quoteRemote(checkout)+' reset --hard HEAD >/dev/null');
  assert.equal(await manager.close(projectId,runId),true);runId=null;pass();
  assert.equal(await scheduler.complete(projectId,taskId,claim.workerId,claim.leaseToken,claim.fence),true);pass();
  assert.equal(checks,16);
  console.log('PASS: compiled S13 Ubuntu SSH gateway, S10 fenced lease, path/command deny, Git read-only, file CAS, Docker tests, cleanup (16/16)');
 }finally{
  if(checkout&&runId&&projectId){
   try{
    await ssh.requireOk('git -C '+quoteRemote(checkout)+' reset --hard HEAD >/dev/null; '+
     'git -C '+quoteRemote(checkout)+' clean -fd >/dev/null');
    await manager.close(projectId,runId);
   }catch(e){console.error('S13 smoke worktree cleanup failed: '+String(e));process.exitCode=1;}
  }
  ssh.close();await pool.end();
  rmSync(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200});
 }
}
