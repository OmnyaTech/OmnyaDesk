import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {UbuntuSshTransport,quoteRemote} from '../dist/packages/db/src/remote-ubuntu.js';
import {RemoteWorktreeManager} from '../dist/packages/db/src/remote-worktrees.js';
import {UbuntuDockerSandbox} from '../dist/packages/db/src/remote-docker-sandbox.js';
if(!process.env.DATABASE_URL||!process.env.OMNYA_S12_REMOTE_CONFIG){
 if(process.env.OMNYA_S12_REQUIRED==='1')throw Error('S12 Ubuntu Server is mandatory');
 console.log('SKIP: Ubuntu Server smoke requires DATABASE_URL and OMNYA_S12_REMOTE_CONFIG');
}else{
 const db=createPool(process.env.DATABASE_URL),repo=new PostgresOfficeRepository(db);
 const ssh=new UbuntuSshTransport(JSON.parse(readFileSync(process.env.OMNYA_S12_REMOTE_CONFIG,'utf8')));
 const manager=new RemoteWorktreeManager(db,ssh);
 const root=mkdtempSync(join(tmpdir(),'omnyadesk-s12-smoke-')),
  work=join(root,'work'),bare=join(root,'origin.git');
 mkdirSync(work);
 const allocated=[];let sentinel=null,checks=0;
 function git(cwd,...args){
  const p=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:12000});
  assert.equal(p.status,0,'Git '+args.join(' ')+' '+String(p.stderr).slice(-220));
  return p.stdout.trim();
 }
 const passed=()=>checks++;
 try{
  await ssh.connect();
  git(root,'init','--bare','--initial-branch=main',bare);
  git(work,'init','--initial-branch=main');
  git(work,'config','user.name','S12 smoke');
  git(work,'config','user.email','s12@example.invalid');
  sentinel=ssh.config.remoteRoot+'/host-sentinel-smoke-'+randomUUID();
  await ssh.requireOk('mkdir -p '+quoteRemote(ssh.config.remoteRoot)+
   '; printf HOST_STILL_SAFE > '+quoteRemote(sentinel));
  const guest=[
   '#!/bin/sh','echo REMOTE_GUEST',
   'id','grep CapEff /proc/self/status',
   'grep NoNewPrivs /proc/self/status','grep Seccomp /proc/self/status',
   'if cat '+sentinel+' >/dev/null 2>&1; then echo ESCAPE=YES; else echo ESCAPE=DENIED; fi',
   'if echo changed >/workspace/README.md 2>/dev/null; then echo WRITE=YES; else echo WRITE=DENIED; fi',
   'if ping -c 1 -W 1 1.1.1.1 >/dev/null 2>&1; then echo NETWORK=YES; else echo NETWORK=DENIED; fi',
   'mkdir -p /tmp/x','if mount -t tmpfs tmpfs /tmp/x >/dev/null 2>&1; then echo MOUNT=YES; else echo MOUNT=DENIED; fi',
   'test ! -e /var/run/docker.sock && echo DOCKER_SOCKET=HIDDEN','echo FINISHED'
  ].join('\n')+'\n';
  writeFileSync(join(work,'README.md'),'S12 Ubuntu baseline\n');
  writeFileSync(join(work,'entry.sh'),guest);
  git(work,'add','.');git(work,'commit','-m','S12 baseline');
  const sha=git(work,'rev-parse','HEAD');
  git(work,'remote','add','origin',bare);git(work,'push','origin','main');
  const p=await repo.createProject({ownerId:randomUUID(),name:'S12 remote smoke '+randomUUID(),
   repositoryRoot:bare,template:'custom'});
  const makeTask=async()=>repo.createTask({projectId:p.project.id,officeId:p.office.id,
   requestedBy:randomUUID(),title:'Ubuntu S12 '+randomUUID(),description:''});
  const a=await manager.create({projectId:p.project.id,taskId:(await makeTask()).id,baseSha:sha});
  allocated.push({projectId:p.project.id,runId:a.runId});
  const b=await manager.create({projectId:p.project.id,taskId:(await makeTask()).id,baseSha:sha});
  allocated.push({projectId:p.project.id,runId:b.runId});
  assert.notEqual(a.checkoutPath,b.checkoutPath);passed();
  assert.notEqual(a.branchRef,b.branchRef);passed();
  assert.equal((await manager.get(p.project.id,a.runId)).state,'ready');passed();
  assert.equal(await ssh.requireOk('git -C '+quoteRemote(a.checkoutPath)+' rev-parse HEAD'),sha);passed();
  assert.equal(await ssh.requireOk('git -C '+quoteRemote(b.checkoutPath)+' rev-parse HEAD'),sha);passed();
  const result=await new UbuntuDockerSandbox(manager).run(p.project.id,a.runId);
  assert.equal(result.ok,true,result.stderr);passed();
  assert.match(result.stdout,/uid=65534/);passed();
  assert.match(result.stdout,/CapEff:\s+0000000000000000/);passed();
  assert.match(result.stdout,/NoNewPrivs:\s+1/);passed();
  assert.match(result.stdout,/Seccomp:\s+2/);passed();
  assert.match(result.stdout,/ESCAPE=DENIED/);passed();
  assert.match(result.stdout,/WRITE=DENIED/);passed();
  assert.match(result.stdout,/NETWORK=DENIED/);passed();
  assert.match(result.stdout,/MOUNT=DENIED/);passed();
  assert.equal(await ssh.requireOk('cat '+quoteRemote(sentinel)),'HOST_STILL_SAFE');passed();
  for(const row of allocated)assert.equal(await manager.close(row.projectId,row.runId),true);
  const left=await ssh.requireOk("docker ps --filter label=com.omnyadesk.sprint=S12 --format '{{.Names}}'");
  assert.equal(left,'');passed();
  assert.equal(checks,16);
  console.log('PASS: compiled Ubuntu Server SSH agent, remote Git worktrees, Docker none/readonly/cap-drop, blocked escape, cleanup (16/16)');
 }finally{
  for(const row of allocated){
   const state=await manager.get(row.projectId,row.runId).catch(()=>null);
   if(state?.state==='ready'){
    try{await manager.close(row.projectId,row.runId);}catch(e){console.error('Remote worktree cleanup failed: '+e.message);process.exitCode=1;}
   }
  }
  if(sentinel){try{await ssh.requireOk('rm -f '+quoteRemote(sentinel));}catch(e){console.error('Sentinel cleanup failed: '+e.message);process.exitCode=1;}}
  ssh.close();await db.end();
  rmSync(root,{recursive:true,force:true,maxRetries:12,retryDelay:300});
 }
}
