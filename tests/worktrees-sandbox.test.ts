import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {before,after,test} from 'node:test';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {UbuntuSshTransport,RemoteUnavailable,quoteRemote} from '../packages/db/src/remote-ubuntu.ts';
import {RemoteWorktreeManager,WorkspaceConflict} from '../packages/db/src/remote-worktrees.ts';
import {UbuntuDockerSandbox} from '../packages/db/src/remote-docker-sandbox.ts';

const enabled=!!process.env.DATABASE_URL&&!!process.env.OMNYA_S12_REMOTE_CONFIG;
let pool:Pool,repo:PostgresOfficeRepository,ssh:UbuntuSshTransport,manager:RemoteWorktreeManager;
const owner=randomUUID();
function git(dir:string,...args:string[]):string{
 const p=spawnSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(p.status,0,'git '+args.join(' ')+' '+String(p.stderr).slice(-200));
 return p.stdout.trim();
}
const script=(sentinel:string)=>[
 '#!/bin/sh',
 'echo GUEST_STARTED',
 'id',
 'grep CapEff /proc/self/status',
 'grep NoNewPrivs /proc/self/status',
 'grep Seccomp /proc/self/status',
 'if cat '+sentinel+' >/dev/null 2>&1; then echo HOST_ESCAPE=YES; else echo HOST_ESCAPE=DENIED; fi',
 'if echo bad >/workspace/README.md 2>/dev/null; then echo WORKSPACE_WRITE=YES; else echo WORKSPACE_WRITE=DENIED; fi',
 'if ping -c 1 -W 1 1.1.1.1 >/dev/null 2>&1; then echo NETWORK=YES; else echo NETWORK=DENIED; fi',
 'mkdir -p /tmp/mount-point',
 'if mount -t tmpfs tmpfs /tmp/mount-point >/dev/null 2>&1; then echo MOUNT=YES; else echo MOUNT=DENIED; fi',
 'if test -e /var/run/docker.sock; then echo DOCKER_SOCKET=VISIBLE; else echo DOCKER_SOCKET=HIDDEN; fi',
 'echo GUEST_FINISHED'
].join('\n')+'\n';
type Fixture={base:string;origin:string;source:string;sha:string;projectId:string;
 task:()=>Promise<string>;close:()=>void;sentinel:string;marker:string};
async function fixture():Promise<Fixture>{
 const base=mkdtempSync(join(tmpdir(),'omnyadesk-s12-ubuntu-'));
 const source=join(base,'source'),origin=join(base,'source.git');
 mkdirSync(source);
 git(base,'init','--bare','--initial-branch=main',origin);
 git(source,'init','--initial-branch=main');
 git(source,'config','user.name','S12 Ubuntu Fixture');
 git(source,'config','user.email','qa@example.invalid');
 const marker='SAFE_'+randomUUID();
 const sentinel=ssh.config.remoteRoot+'/host-sentinel-'+randomUUID();
 await ssh.requireOk('mkdir -p '+quoteRemote(ssh.config.remoteRoot)+
  '; printf '+quoteRemote(marker)+' > '+quoteRemote(sentinel));
 writeFileSync(join(source,'README.md'),'original\n');
 writeFileSync(join(source,'entry.sh'),script(sentinel));
 git(source,'add','.');git(source,'commit','-m','base fixture');
 const sha=git(source,'rev-parse','HEAD');
 git(source,'remote','add','origin',origin);git(source,'push','origin','main');
 const p=await repo.createProject({ownerId:owner,name:'S12 remote '+randomUUID(),
  repositoryRoot:origin,template:'custom'});
 return {base,source,origin,sha,projectId:p.project.id,marker,sentinel,
  async task(){
   const t=await repo.createTask({projectId:p.project.id,officeId:p.office.id,
    requestedBy:owner,title:'S12 '+randomUUID(),description:''});
   return t.id;
  },close(){rmSync(base,{recursive:true,force:true,maxRetries:6,retryDelay:250});}};
}
async function closeFixture(f:Fixture):Promise<void>{
 await ssh.requireOk('rm -f '+quoteRemote(f.sentinel));
 f.close();
}
before(async()=>{
 if(!enabled)return;
 pool=createPool(process.env.DATABASE_URL!);
 await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);
 ssh=new UbuntuSshTransport(JSON.parse(readFileSync(process.env.OMNYA_S12_REMOTE_CONFIG!,'utf8')));
 await ssh.connect();
 manager=new RemoteWorktreeManager(pool,ssh);
});
after(async()=>{ssh?.close();if(pool)await pool.end();});

test('S12 Ubuntu migration versioned and SSH host pin/container digest enforced',{skip:!enabled},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 const q=await pool.query("SELECT 1 FROM schema_migrations WHERE name='010_ubuntu_remote_worktrees.sql'");
 assert.equal(q.rowCount,1);
 assert.equal(ssh.config.image.startsWith('alpine@sha256:'),true);
 assert.equal((await ssh.requireOk('docker image inspect '+quoteRemote(ssh.config.image)+
  " --format '{{.Id}}'")).length>10,true);
 assert.match(ssh.config.remoteRoot,/^\/home\//);
});

test('S12 Ubuntu two remote worktrees separate; dirty source cannot be deleted',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const a=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:f.sha});
  const b=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:f.sha});
  assert.notEqual(a.checkoutPath,b.checkoutPath);
  assert.notEqual(a.branchRef,b.branchRef);
  assert.equal(a.executionBackend,'ubuntu_ssh_docker');
  assert.equal((await ssh.requireOk('git -C '+quoteRemote(a.checkoutPath)+' rev-parse HEAD')),f.sha);
  assert.equal((await ssh.requireOk('git -C '+quoteRemote(b.checkoutPath)+' rev-parse HEAD')),f.sha);
  await ssh.requireOk('printf "dirty\\n" > '+quoteRemote(a.checkoutPath+'/README.md'));
  assert.equal(await ssh.requireOk('cat '+quoteRemote(b.checkoutPath+'/README.md')),'original');
  await assert.rejects(manager.close(f.projectId,a.runId),WorkspaceConflict);
  await ssh.requireOk('git -C '+quoteRemote(a.checkoutPath)+' checkout -- README.md');
  assert.equal(await manager.close(f.projectId,a.runId),true);
  assert.equal(await manager.close(f.projectId,b.runId),true);
  assert.equal((await manager.get(f.projectId,a.runId))?.state,'closed');
 }finally{await closeFixture(f);}
});

test('S12 Ubuntu 12 concurrent claims for same task create one remote checkout',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const id=await f.task();
  const settled=await Promise.allSettled(Array.from({length:12},()=>manager.create({
   projectId:f.projectId,taskId:id,baseSha:f.sha
  })));
  const accepted=settled.filter(x=>x.status==='fulfilled');
  assert.equal(accepted.length,1);
  const single=(accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof manager.create>>>).value;
  assert.equal((await pool.query(
   "SELECT count(*)::int n FROM execution_worktrees WHERE project_id=$1 AND task_id=$2 AND state='ready'",
   [f.projectId,id])).rows[0].n,1);
  await manager.close(f.projectId,single.runId);
  assert.equal((await ssh.requireOk('test ! -e '+quoteRemote(single.checkoutPath)+' && echo GONE')),'GONE');
 }finally{await closeFixture(f);}
});

test('S12 real Ubuntu Docker denies host, network, writes and mounts',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const row=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:f.sha});
  try{
   const result=await new UbuntuDockerSandbox(manager).run(f.projectId,row.runId);
   assert.equal(result.ok,true,result.stderr);
   assert.match(result.stdout,/GUEST_STARTED/);
   assert.match(result.stdout,/uid=65534/);
   assert.match(result.stdout,/CapEff:\s+0000000000000000/);
   assert.match(result.stdout,/NoNewPrivs:\s+1/);
   assert.match(result.stdout,/Seccomp:\s+2/);
   for(const tag of ['HOST_ESCAPE=DENIED','WORKSPACE_WRITE=DENIED','NETWORK=DENIED',
    'MOUNT=DENIED','DOCKER_SOCKET=HIDDEN','GUEST_FINISHED'])assert.ok(result.stdout.includes(tag),tag);
   assert.equal(await ssh.requireOk('cat '+quoteRemote(f.sentinel)),f.marker);
   assert.equal(await ssh.requireOk('cat '+quoteRemote(row.checkoutPath+'/README.md')),'original');
   assert.equal((await ssh.requireOk("docker ps --filter label=com.omnyadesk.sprint=S12 --format '{{.Names}}'")).length,0);
  }finally{await manager.close(f.projectId,row.runId);}
 }finally{await closeFixture(f);}
});

test('S12 host rejects invalid base, wrong tenant, unsafe executable files and closed run',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const id=await f.task();
  await assert.rejects(manager.create({projectId:randomUUID(),taskId:id,baseSha:f.sha}));
  await assert.rejects(manager.create({projectId:f.projectId,taskId:id,baseSha:'a'.repeat(40)}));
  const a=await manager.create({projectId:f.projectId,taskId:id,baseSha:f.sha});
  await assert.rejects(manager.create({projectId:f.projectId,taskId:id,baseSha:f.sha}),WorkspaceConflict);
  await assert.rejects(new UbuntuDockerSandbox(manager).run(randomUUID(),a.runId),RemoteUnavailable);
  await manager.close(f.projectId,a.runId);
  await assert.rejects(new UbuntuDockerSandbox(manager).run(f.projectId,a.runId),RemoteUnavailable);
  git(f.source,'update-index','--chmod=+x','entry.sh');git(f.source,'commit','-m','unsafe executable');
  const sha=git(f.source,'rev-parse','HEAD');
  await assert.rejects(manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:sha}),WorkspaceConflict);
 }finally{await closeFixture(f);}
});


test('S12 running Ubuntu container has actual Docker cgroup, seccomp and mount limits',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  writeFileSync(join(f.source,'entry.sh'),'#!/bin/sh\necho READY_FOR_INSPECT\nsleep 7\n');
  git(f.source,'add','.');git(f.source,'commit','-m','inspection fixture');
  const sha=git(f.source,'rev-parse','HEAD');
  git(f.source,'push','origin','main');
  const row=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:sha});
  try{
   const running=new UbuntuDockerSandbox(manager).run(f.projectId,row.runId);
   let name='';
   for(let i=0;i<30;i++){
    const found=await ssh.requireOk('docker ps --filter '+
     quoteRemote('label=com.omnyadesk.run='+row.runId)+" --format '{{.Names}}'");
    if(found){name=found.trim();break;}
    await new Promise(resolve=>setTimeout(resolve,130));
   }
   assert.match(name,/^omnyadesk-s12-/);
   const host=JSON.parse(await ssh.requireOk(
    'docker inspect --format '+"'{{json .HostConfig}}'"+' '+quoteRemote(name)
   ));
   const config=JSON.parse(await ssh.requireOk(
    'docker inspect --format '+"'{{json .Config}}'"+' '+quoteRemote(name)
   ));
   assert.equal(host.NetworkMode,'none');
   assert.equal(host.ReadonlyRootfs,true);
   assert.equal(host.Privileged,false);
   assert.equal(host.PidsLimit,32);
   assert.equal(host.Memory,134217728);
   assert.ok(host.NanoCpus===500000000||host.CpuQuota===50000,'CPU must be restricted to 0.5');
   assert.ok(host.CapDrop.includes('ALL'));
   assert.ok(host.SecurityOpt.some((s:string)=>s.includes('no-new-privileges')));
   assert.equal(config.User,'65534:65534');
   assert.equal(host.Mounts.length,1);
   assert.equal(host.Mounts[0].Target,'/workspace');
   assert.equal(host.Mounts[0].ReadOnly,true);
   assert.equal((await running).ok,true);
   assert.equal(await ssh.requireOk('docker ps --filter '+
    quoteRemote('label=com.omnyadesk.run='+row.runId)+" --format '{{.Names}}'"),'');
  }finally{await manager.close(f.projectId,row.runId);}
 }finally{await closeFixture(f);}
});

test('S12 long-running process is interrupted and only its own container removed',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  writeFileSync(join(f.source,'entry.sh'),'#!/bin/sh\nsleep 35\n');
  git(f.source,'add','.');git(f.source,'commit','-m','timeout fixture');
  const sha=git(f.source,'rev-parse','HEAD');
  git(f.source,'push','origin','main');
  const row=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:sha});
  try{
   const result=await new UbuntuDockerSandbox(manager).run(f.projectId,row.runId);
   assert.equal(result.ok,false);
   assert.ok([124,137,143,255].includes(result.exitCode),'timeout/termination exit '+result.exitCode);
   assert.equal(await ssh.requireOk('docker ps --filter '+
    quoteRemote('label=com.omnyadesk.run='+row.runId)+" --format '{{.Names}}'"),'');
  }finally{await manager.close(f.projectId,row.runId);}
 }finally{await closeFixture(f);}
});


test('S12 collision of remote runId preserves pre-existing host data',{skip:!enabled},async()=>{
 const f=await fixture();
 const runId=randomUUID(),root=ssh.config.remoteRoot+'/projects/'+f.projectId+'/'+runId;
 try{
  await ssh.requireOk('mkdir -p '+quoteRemote(root)+'; printf EXISTING > '+quoteRemote(root+'/marker'));
  await assert.rejects(manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:f.sha,runId}),WorkspaceConflict);
  assert.equal(await ssh.requireOk('cat '+quoteRemote(root+'/marker')),'EXISTING');
  assert.equal((await pool.query(
   'SELECT 1 FROM execution_worktrees WHERE project_id=$1 AND run_id=$2',
   [f.projectId,runId])).rowCount,0);
 }finally{
  await ssh.requireOk('test ! -L '+quoteRemote(root)+' && rm -rf -- '+quoteRemote(root));
  await closeFixture(f);
 }
});

test('S12 pinned SSH rejects an incorrect server fingerprint',{skip:!enabled},async()=>{
 const config=JSON.parse(readFileSync(process.env.OMNYA_S12_REMOTE_CONFIG!,'utf8'));
 config.hostFingerprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
 const wrong=new UbuntuSshTransport(config);
 try{await assert.rejects(wrong.connect(),RemoteUnavailable);}
 finally{wrong.close();}
});


test('S12 Git bundle transmits only requested commit, never unrelated private branches',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  git(f.source,'switch','-c','private-marker');
  writeFileSync(join(f.source,'private-only.txt'),'PRIVATE_FIXTURE_MUST_NOT_TRANSFER\n');
  git(f.source,'add','.');
  git(f.source,'commit','-m','private unrelated branch');
  const privateSha=git(f.source,'rev-parse','HEAD');
  git(f.source,'push','origin','private-marker');
  const row=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:f.sha});
  try{
   const root=row.checkoutPath.replace(/\/workspace$/,'/source.git');
   const missing=await ssh.exec('git -C '+quoteRemote(root)+' cat-file -e '+
    quoteRemote(privateSha)+' >/dev/null 2>&1');
   assert.notEqual(missing.exitCode,0,'Unrelated commit must not be shipped to server');
   assert.equal(await ssh.requireOk('git -C '+quoteRemote(root)+' rev-parse '+
    quoteRemote(row.baseSha)),row.baseSha);
   const refs=await ssh.requireOk('git -C '+quoteRemote(root)+
    " for-each-ref --format='%(refname)' refs/heads");
   assert.ok(!refs.includes('private-marker'));
  }finally{await manager.close(f.projectId,row.runId);}
 }finally{await closeFixture(f);}
});


test('S13 recovery closes clean Ubuntu run after disposable canonical Git source disappears',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const row=await manager.create({projectId:f.projectId,taskId:await f.task(),baseSha:f.sha});
  // Simulate a reboot/crash after an isolated remote checkout was allocated:
  // the local QA bare repository is gone but the remote run and DB row persist.
  rmSync(f.origin,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  assert.equal(await manager.close(f.projectId,row.runId),true);
  assert.equal((await manager.get(f.projectId,row.runId))?.state,'closed');
  assert.equal(await ssh.requireOk('test ! -e '+
   quoteRemote(row.checkoutPath)+' && echo REMOVED'),'REMOVED');
 }finally{await closeFixture(f);}
});
