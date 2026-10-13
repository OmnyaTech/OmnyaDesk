import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test,before,after} from 'node:test';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {ResourceScheduler,type Claim} from '../packages/db/src/scheduler.ts';
import {RemoteWorktreeManager} from '../packages/db/src/remote-worktrees.ts';
import {UbuntuSshTransport,quoteRemote} from '../packages/db/src/remote-ubuntu.ts';
import {UbuntuToolGateway,ToolDenied,ToolRequestSchema} from '../packages/db/src/tool-gateway.ts';

const enabled=!!process.env.DATABASE_URL&&!!process.env.OMNYA_S12_REMOTE_CONFIG;
let db:Pool,repo:PostgresOfficeRepository,scheduler:ResourceScheduler,manager:RemoteWorktreeManager,
 ssh:UbuntuSshTransport,gateway:UbuntuToolGateway;
const owner=randomUUID();
function git(dir:string,...args:string[]):string{
 const p=spawnSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true,timeout:12000});
 assert.equal(p.status,0,'Git '+args.join(' ')+': '+String(p.stderr).slice(-120));
 return p.stdout.trim();
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
type Fixture={base:string;root:string;projectId:string;taskId:string;runId:string;
 claim:Claim;close:()=>Promise<void>;request:(tool:string,props?:Record<string,unknown>)=>Record<string,unknown>};
async function fixture(resourceKey='repo',mode:'read'|'write'='write',ttl=80000):Promise<Fixture>{
 const base=mkdtempSync(join(tmpdir(),'omnyadesk-s13-')),source=join(base,'src'),bare=join(base,'bare.git');
 mkdirSync(source);
 git(base,'init','--bare','--initial-branch=main',bare);
 git(source,'init','--initial-branch=main');
 git(source,'config','user.name','S13 QA');git(source,'config','user.email','qa@example.invalid');
 mkdirSync(join(source,'docs'));
 writeFileSync(join(source,'README.md'),'safe baseline\n');
 writeFileSync(join(source,'docs','notes.md'),'documentation\n');
 writeFileSync(join(source,'entry.sh'),'#!/bin/sh\necho S13_ENTRY_PASS\nid\n');
 git(source,'add','.');git(source,'commit','-m','baseline');
 const baseSha=git(source,'rev-parse','HEAD');
 git(source,'remote','add','origin',bare);git(source,'push','origin','main');
 const project=await repo.createProject({ownerId:owner,name:'S13 '+randomUUID(),repositoryRoot:bare,template:'custom'});
 const task=await repo.createTask({projectId:project.project.id,officeId:project.office.id,
  requestedBy:owner,title:'S13 '+randomUUID(),description:''});
 await scheduler.register({projectId:project.project.id,taskId:task.id,
  resources:[{key:resourceKey,mode}],priority:5,dependsOn:[]});
 const workerId='s13-'+randomUUID();
 const claim=await scheduler.claim(project.project.id,workerId,ttl);
 assert.ok(claim);assert.equal(claim.taskId,task.id);
 const row=await manager.create({projectId:project.project.id,taskId:task.id,baseSha});
 return {
  base,root:row.checkoutPath,projectId:project.project.id,taskId:task.id,runId:row.runId,claim,
  request(tool,props={}){return {projectId:project.project.id,taskId:task.id,runId:row.runId,
   workerId:claim.workerId,leaseToken:claim.leaseToken,fence:claim.fence,tool,...props};},
  async close(){
   try{
    await ssh.requireOk('git -C '+quoteRemote(row.checkoutPath)+' reset --hard HEAD >/dev/null; '+
     'git -C '+quoteRemote(row.checkoutPath)+' clean -fd >/dev/null');
    await manager.close(project.project.id,row.runId);
    await scheduler.complete(project.project.id,task.id,claim.workerId,claim.leaseToken,claim.fence);
   }finally{rmSync(base,{recursive:true,force:true,maxRetries:9,retryDelay:250});}
  }
 };
}
before(async()=>{
 if(!enabled)return;
 db=createPool(process.env.DATABASE_URL!);await runMigrations(db);
 repo=new PostgresOfficeRepository(db);scheduler=new ResourceScheduler(db);
 ssh=new UbuntuSshTransport(JSON.parse(readFileSync(process.env.OMNYA_S12_REMOTE_CONFIG!,'utf8')));
 await ssh.connect();manager=new RemoteWorktreeManager(db,ssh);gateway=new UbuntuToolGateway(db,manager);
});
after(async()=>{ssh?.close();if(db)await db.end();});
test('S13 strict tool schema denies arbitrary commands, switches and escape paths',()=>{
 const base={projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
  workerId:'s13worker',leaseToken:randomUUID(),fence:1};
 const invalid=[
  {...base,tool:'shell.exec',command:'rm -rf /'},
  {...base,tool:'git.push'},
  {...base,tool:'git.commit'},
  {...base,tool:'git.reset'},
  {...base,tool:'tests.run',suite:'../../bin/bash'},
  {...base,tool:'tests.run',suite:'npm test'},
  {...base,tool:'git.status',args:['--exec-path']},
  {...base,tool:'files.write',path:'README.md',content:'x',expectedSha:'absent',command:'echo'},
  ...['../host.txt','/etc/passwd','docs/../../secret.md','.git/config','docs/.env',
     'docs//a.md','docs/%2e%2e/a.md','docs\\evil.md','-c.md','README.md;id',
     'entry.sh','/home/test-user/blocked/example.txt','src/./x.md','docs/a.sh'].map(path=>
    ({...base,tool:'files.read',path})),
  {...base,tool:'files.write',path:'README.md',content:'A'.repeat(16385),expectedSha:'absent'}
 ];
 for(const req of invalid)assert.equal(ToolRequestSchema.safeParse(req).success,false,
  'Unexpectedly accepted '+JSON.stringify(req).slice(0,100));
 assert.equal(ToolRequestSchema.safeParse({...base,tool:'files.read',path:'README.md'}).success,true);
});
test('S13 read-only Git + files gateway works on actual Ubuntu worktree',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const root=await gateway.run(f.request('files.list',{path:'.'}) as never);
  assert.ok(JSON.stringify(root.result).includes('README.md'));
  const read=await gateway.run(f.request('files.read',{path:'README.md'}) as never);
  assert.deepEqual(read.result,{text:'safe baseline\n',sha256:sha('safe baseline\n')});
  const nested=await gateway.run(f.request('files.read',{path:'docs/notes.md'}) as never);
  assert.equal((nested.result as {text:string}).text,'documentation\n');
  const status=await gateway.run(f.request('git.status') as never);
  assert.equal((status.result as {text:string}).text,'');
  const diff=await gateway.run(f.request('git.diff',{path:'README.md'}) as never);
  assert.equal((diff.result as {text:string}).text,'');
 }finally{await f.close();}
});
test('S13 write uses scoped CAS, rejects stale/version mismatch and Git remains unmerged',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const text='gateway mutation\n';
  const req=f.request('files.write',{path:'README.md',content:text,expectedSha:sha('safe baseline\n')});
  const done=await gateway.run(req as never);
  assert.equal((done.result as {sha256:string}).sha256,sha(text));
  const status=await gateway.run(f.request('git.status') as never);
  assert.match((status.result as {text:string}).text,/README\.md/);
  const patch=await gateway.run(f.request('git.diff',{path:'README.md'}) as never);
  assert.match((patch.result as {text:string}).text,/gateway mutation/);
  await assert.rejects(gateway.run(req as never),ToolDenied);
  await assert.rejects(gateway.run(f.request('files.write',{path:'README.md',
   content:'conflict\n',expectedSha:'absent'}) as never),ToolDenied);
  const added=await gateway.run(f.request('files.write',{path:'new.md',content:'created\n',expectedSha:'absent'}) as never);
  assert.equal((added.result as {bytes:number}).bytes,8);
  assert.equal((await gateway.run(f.request('files.read',{path:'new.md'}) as never)).success,true);
  // Only S11 approved integration may update the canonical bare repo; gateway never merges.
  assert.equal((await ssh.requireOk('git -C '+quoteRemote(f.root.replace('/workspace','/source.git'))+
   ' rev-parse refs/heads/s12-base')).length,40);
 }finally{await f.close();}
});
test('S13 requires exact worker/lease/fence/task/run/project; missing claim denied',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const attempts=[
   {workerId:'intruder'},
   {leaseToken:randomUUID()},
   {fence:f.claim.fence+1},
   {taskId:randomUUID()},
   {projectId:randomUUID()},
   {runId:randomUUID()}
  ];
  for(const changed of attempts)await assert.rejects(
   gateway.run(f.request('files.read',{path:'README.md',...changed}) as never),ToolDenied);
  assert.equal((await gateway.run(f.request('files.read',{path:'README.md'}) as never)).success,true);
 }finally{await f.close();}
});
test('S13 S10 resource scope restricts files and rejects write under read lease',{skip:!enabled},async()=>{
 const f=await fixture('path:docs','read');
 try{
  assert.equal((await gateway.run(f.request('files.read',{path:'docs/notes.md'}) as never)).success,true);
  for(const request of [
   f.request('files.read',{path:'README.md'}),
   f.request('files.list',{path:'.'}),
   f.request('files.write',{path:'docs/notes.md',content:'X',expectedSha:sha('documentation\n')}),
   f.request('git.status'),
   f.request('tests.run',{suite:'entry'})
  ])await assert.rejects(gateway.run(request as never),ToolDenied);
 }finally{await f.close();}
});
test('S13 SFTP helper refuses symlink pointing at host sentinel, including parent symlink',{skip:!enabled},async()=>{
 const f=await fixture();
 const sentinel=ssh.config.remoteRoot+'/s13-host-sentinel-'+randomUUID();
 try{
  await ssh.requireOk('printf SECRET_CANARY > '+quoteRemote(sentinel));
  await ssh.requireOk('ln -s '+quoteRemote(sentinel)+' '+quoteRemote(f.root+'/outside.md')+
   ' && ln -s '+quoteRemote(ssh.config.remoteRoot)+' '+quoteRemote(f.root+'/outside'));
  for(const path of ['outside.md','outside/anything.md']){
   await assert.rejects(gateway.run(f.request('files.read',{path}) as never),ToolDenied);
  }
  assert.equal(await ssh.requireOk('cat '+quoteRemote(sentinel)),'SECRET_CANARY');
 }finally{
  await ssh.exec('rm -f '+quoteRemote(sentinel)+' '+quoteRemote(f.root+'/outside.md')+
   ' '+quoteRemote(f.root+'/outside')).catch(()=>{});
  await f.close();
 }
});
test('S13 remote tests only fixed suite and Docker denies escape while S10 lease valid',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const result=await gateway.run(f.request('tests.run',{suite:'entry'}) as never);
  assert.equal(result.success,true);
  assert.equal((result.result as {exitCode:number}).exitCode,0);
  assert.match((result.result as {stdout:string}).stdout,/S13_ENTRY_PASS/);
  // S12 tests may be running in parallel; audit ONLY our run's container label.
  assert.equal(await ssh.requireOk('docker ps -a --filter '+
   quoteRemote('label=com.omnyadesk.run='+f.runId)+" --format '{{.Names}}'"),'');
 }finally{await f.close();}
});
test('S13 completed S10 claim cannot authorize additional remote tools',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  assert.equal(await scheduler.complete(f.projectId,f.taskId,f.claim.workerId,
   f.claim.leaseToken,f.claim.fence),true);
  await assert.rejects(gateway.run(f.request('files.read',{path:'README.md'}) as never),ToolDenied);
 }finally{await f.close();}
});


test('S13 concurrent same-SHA writers are serialized on Ubuntu and cannot overwrite each other',{skip:!enabled},async()=>{
 const f=await fixture();
 try{
  const original=sha('safe baseline\n');
  const [a,b]=await Promise.allSettled([
   gateway.run(f.request('files.write',{path:'README.md',content:'first\n',expectedSha:original}) as never),
   gateway.run(f.request('files.write',{path:'README.md',content:'second\n',expectedSha:original}) as never)
  ]);
  const successes=[a,b].filter(x=>x.status==='fulfilled');
  assert.equal(successes.length,1);
  const content=(await gateway.run(f.request('files.read',{path:'README.md'}) as never)).result as {text:string};
  assert.ok(content.text==='first\n'||content.text==='second\n');
  const dir=f.root.slice(0,-('/workspace'.length));
  const remainders=await ssh.requireOk('find '+quoteRemote(dir)+
   " -maxdepth 1 -name 's13-*.py' -type f | wc -l");
  assert.equal(Number(remainders),0);
 }finally{await f.close();}
});
test('S13 stale lease after TTL expires is fenced, reclaimed S10 lease works',{skip:!enabled},async()=>{
 const f=await fixture('repo','write',250);
 try{
  const replacement=await scheduler.claim(f.projectId,'s13-new-'+randomUUID(),85000);
  assert.ok(replacement);
  assert.ok(replacement.fence>f.claim.fence);
  await assert.rejects(gateway.run(f.request('files.read',{path:'README.md'}) as never),ToolDenied);
  const fresh=f.request('files.read',{path:'README.md',workerId:replacement.workerId,
   leaseToken:replacement.leaseToken,fence:replacement.fence});
  assert.equal((await gateway.run(fresh as never)).success,true);
  assert.equal(await scheduler.complete(f.projectId,f.taskId,replacement.workerId,
   replacement.leaseToken,replacement.fence),true);
 }finally{await f.close();}
});
