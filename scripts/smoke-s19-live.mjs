import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {ResourceScheduler} from '../dist/packages/db/src/scheduler.js';
import {UbuntuSshTransport,quoteRemote} from '../dist/packages/db/src/remote-ubuntu.js';
import {RemoteWorktreeManager} from '../dist/packages/db/src/remote-worktrees.js';
import {EvidenceLedger} from '../dist/packages/db/src/evidence-ledger.js';
import {STAGE_ORDER} from '../dist/packages/pipeline/src/four-role.js';

if(process.env.OMNYA_S19_LIVE!=='1'||!process.env.DATABASE_URL||
 !process.env.OMNYA_S12_REMOTE_CONFIG||!process.env.OMNYA_S17_RUNTIME_ROOT)
 throw Error('Explicit opt-in and private S12 config required');
const mode=process.env.OMNYA_S19_MODE;
if(!['success','budget','kill'].includes(mode))throw Error('S19_MODE must be success, budget or kill');
const root=process.env.OMNYA_S17_RUNTIME_ROOT;
if(!/^\/home\/[a-z_][a-z0-9_-]*\/\.local\/share\/omnyadesk\/s17$/.test(root))
 throw Error('S17 trusted runtime root required');
const approvedRoot=root.slice(0,-4)+'/s12/projects';
const runtime=root+'/runtime/pilot';
const pool=createPool(process.env.DATABASE_URL);
const repo=new PostgresOfficeRepository(pool);
const scheduler=new ResourceScheduler(pool);
const ssh=new UbuntuSshTransport(JSON.parse(readFileSync(process.env.OMNYA_S12_REMOTE_CONFIG,'utf8')));
const manager=new RemoteWorktreeManager(pool,ssh),ledger=new EvidenceLedger(pool);
const temp=mkdtempSync(join(tmpdir(),'omnyadesk-s18-live-'));
const src=join(temp,'source'),bare=join(temp,'origin.git');
let work,claim,container,projectId,taskId,completed=false;
const git=(where,...args)=>{
 const out=spawnSync('git',['-C',where,...args],{encoding:'utf8',timeout:20000,windowsHide:true});
 assert.equal(out.status,0,'Disposable fixture Git step failed');
 return out.stdout.trim();
};
try{
 await ssh.connect();
 git(temp,'init','--bare','--initial-branch=main',bare);
 mkdirSync(src);git(src,'init','--initial-branch=main');
 git(src,'config','user.name','S18 synthetic test');
 git(src,'config','user.email','s18@example.invalid');
 writeFileSync(join(src,'README.md'),
  'S18_SYNTHETIC fixture; synthetic task only. No customer data. No production deployment. Respond concisely.\n');
 writeFileSync(join(src,'entry.sh'),'#!/bin/sh\nprintf S18_SYNTHETIC\n');
 git(src,'add','.');git(src,'commit','-m','Add synthetic S18 fixture');
 const sha=git(src,'rev-parse','HEAD');
 git(src,'remote','add','origin',bare);git(src,'push','origin','main');
 const created=await repo.createProject({ownerId:randomUUID(),
  name:'S18 real synthetic sandbox '+randomUUID(),repositoryRoot:bare,template:'custom'});
 projectId=created.project.id;
 const task=await repo.createTask({projectId,officeId:created.office.id,
  requestedBy:randomUUID(),title:'S18 four stage real synthetic check',
  description:'No external side effects'});
 taskId=task.id;
 await scheduler.register({projectId,taskId,resources:[{key:'repo',mode:'write'}],
  priority:3,dependsOn:[]});
 claim=await scheduler.claim(projectId,'s18-live-'+randomUUID(),85000);
 assert.ok(claim,'S10 lease was denied');
 work=await manager.create({projectId,taskId,baseSha:sha});
 assert.equal((await manager.get(projectId,work.runId))?.state,'ready');
 const runDir=work.checkoutPath.slice(0,-'/workspace'.length);
 const input={
  goal:'Only analyze the synthetic S18_SYNTHETIC fixture in text. Each stage response must include S18_SYNTHETIC and be below 90 words. The developer should propose a text-only plan. The reviewer must explicitly use the word risk and note that no human approval or Git merge occurred. Never claim production deployment, verified real code changes or human approval.',
  actors:{architect:'s18-codex-architect',developer:'s18-codex-developer',
   qa:'s18-codex-qa',reviewer:'s18-codex-reviewer'},
  request:{projectId,taskId,runId:work.runId,role:'architect',
   prompt:'Read only README.md. Produce four distinct staged text-only reviews without changing files or invoking commands. Include S18_SYNTHETIC and discuss risk as reviewer. No human approval.',
   workspacePath:work.checkoutPath,sandboxId:'codex-'+work.runId,
   modelId:'default',allowedTools:[],maxSteps:24,maxCostUsd:1.0}
 };
 const files=[
  ['dist/packages/adapters/src/codex.js','packages/adapters/src/codex.js'],
  ['dist/packages/contracts/src/provider.js','packages/contracts/src/provider.js'],
  ['dist/packages/contracts/src/domain.js','packages/contracts/src/domain.js'],
  ['dist/packages/pipeline/src/four-role.js','packages/pipeline/src/four-role.js'],
  ['dist/packages/pipeline/src/resilience.js','packages/pipeline/src/resilience.js'],
  ['scripts/s19-live-guest.mjs','s19-guest.mjs'],
  ['scripts/s18-independent-check.mjs','independent-check.mjs']
 ];
 await ssh.requireOk('mkdir -p '+quoteRemote(runtime+'/packages/pipeline/src'));
 for(const [local,dest] of files)await ssh.upload(join(process.cwd(),local),runtime+'/'+dest);
 const payload=join(temp,'input.json');
 writeFileSync(payload,JSON.stringify(input)+'\n');
 await ssh.upload(payload,runtime+'/input.json');
 const fixture=join(temp,'fixture-metadata.json');
 writeFileSync(fixture,JSON.stringify({readme:work.checkoutPath+'/README.md'})+'\n');
 await ssh.upload(fixture,runtime+'/fixture-metadata.json');
 container='omnyadesk-s19-'+work.runId;
 const remote=`set -eu
root=${root}
checkout=${work.checkoutPath}
rundir=${runDir}
test -d "$checkout" && test -d "$rundir/source.git"
authip=$(getent ahostsv4 auth.openai.com | awk 'NR==1{print $1}')
apiip=$(getent ahostsv4 api.openai.com | awk 'NR==1{print $1}')
test -n "$authip" && test -n "$apiip"
exec docker run --rm --name ${container} --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --pids-limit 96 --memory 1280m --cpus 1 --network bridge --tmpfs /tmp:rw,nosuid,nodev,size=64m --add-host "auth.openai.com:$authip" --add-host "api.openai.com:$apiip" -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt -e HOME=/auth -e CODEX_HOME=/auth -e OMNYA_S19_ISOLATED_GUEST=1 -e OMNYA_S19_MODE=${mode} -e OMNYA_S17_APPROVED_WORKSPACE_ROOT=${approvedRoot} -v "$root/runtime:/runtime:ro" -v "$root/auth:/auth:rw" -v "$checkout:$checkout:ro" -v "$rundir/source.git:$rundir/source.git:ro" -w /runtime/pilot --label com.omnyadesk.sprint=S19 --label com.omnyadesk.run=${work.runId} node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 node /runtime/pilot/s19-guest.mjs`;
 let result;
 if(mode==='kill'){
  const running=ssh.exec(remote,90000);
  let found=false;
  const query='docker ps --filter name='+quoteRemote(container)+
   ' --filter label=com.omnyadesk.sprint=S19 --filter label=com.omnyadesk.run='+work.runId+
   ' --format "{{.Names}}"';
  for(let attempt=0;attempt<30;attempt++){
   await new Promise(resolve=>setTimeout(resolve,200));
   const listed=await ssh.exec(query,5000);
   if(listed.exitCode===0&&listed.stdout.trim()===container){found=true;break;}
  }
  assert.ok(found,'No owned S19 test container to kill');
  await new Promise(resolve=>setTimeout(resolve,1300));
  const identity=await ssh.requireOk(query,5000);
  assert.equal(identity,container,'Test container ownership changed');
  assert.equal(await ssh.requireOk('docker rm -f '+quoteRemote(container),12000),container);
  result=await running;
  assert.notEqual(result.exitCode,0,'Killed container must fail');
  assert.ok(!result.stdout.includes('"status":"completed"'));
  assert.equal(await ssh.requireOk('test -z "$(git -C '+quoteRemote(work.checkoutPath)+
   ' status --porcelain)" && echo CLEAN'),'CLEAN');
  completed=true;
  console.log('S19_KILL_RESULT='+JSON.stringify({status:'PASS',
   ownedContainerStopped:true,processExit:result.exitCode,gitClean:true,
   humanApproval:false,gitIntegrated:false}));
 }else{
 result=await ssh.exec(remote,90000);
 const row=result.stdout.split(/\r?\n/).find(x=>x.startsWith('S19_LIVE_RECEIPT='));
 if(!row){
  const msg=result.stderr.split(/\r?\n/).filter(x=>/SyntaxError|Error \[|Error:|Cannot find|not found|ERR_|TypeError|ReferenceError/.test(x)).slice(0,4).map(x=>x.replace(/https?:\/\/\S+/g,'[URL]').replace(/Bearer\s+\S+/gi,'[TOKEN]').replace(/[A-Za-z0-9_-]{40,}/g,'[REDACTED]').slice(0,200));
  console.error('S19_SAFE_BOOT_DIAG='+JSON.stringify({exitCode:result.exitCode,
   stderrClasses:msg,stdoutLabels:result.stdout.split(/\r?\n/).filter(x=>/^S19_/.test(x)).map(x=>x.slice(0,50))}));
  throw Error('No content-free S19 guest receipt');
 }
 const received=JSON.parse(row.slice('S19_LIVE_RECEIPT='.length));
 if(mode==='budget'){
  assert.notEqual(result.exitCode,0,'Insufficient global token budget must fail');
  assert.equal(received.status,'failed');
  assert.equal(received.errorCategory,'TOKEN_BUDGET_EXCEEDED');
  assert.ok(received.stageStates?.architect?.started);
  assert.equal(received.stageStates?.developer,undefined);
  assert.equal(await ssh.requireOk('test -z "$(git -C '+quoteRemote(work.checkoutPath)+
   ' status --porcelain)" && echo CLEAN'),'CLEAN');
  completed=true;
  console.log('S19_BUDGET_RESULT='+JSON.stringify({status:'PASS',
   errorCode:received.errorCategory,architectStarted:true,developerStarted:false,
   gitClean:true,humanApproval:false,gitIntegrated:false}));
 }else{
 if(result.exitCode!==0||received.status!=='completed'){
  console.error('S19_PILOT_SAFE_FAILURE='+JSON.stringify({
   exitCode:result.exitCode,errorCategory:received.errorCategory,
   stages:received.stageStates,reason:'Live four-role execution did not pass'}));
  throw Error('Real four-role execution rejected');
 }
 assert.deepEqual(received.stageReceipts.map(x=>x.role),[...STAGE_ORDER]);
 assert.equal(received.projectId,projectId);assert.equal(received.taskId,taskId);
 assert.equal(received.physicalRunId,work.runId);
 assert.ok(received.humanApprovalRequired&&!received.gitIntegrated);
 assert.equal(received.statusCode,'awaiting_human_approval');
 assert.ok(received.estimatedTotalUsd>0&&received.estimatedTotalUsd<=1.0);
 assert.equal(received.globalUsage.retries,0);
 assert.equal(received.globalUsage.providerAttempts,4);
 assert.equal(received.globalUsage.inputTokens,
  received.stageReceipts.reduce((sum,stage)=>sum+stage.inputTokens,0));
 for(const role of STAGE_ORDER){
  const types=received.modelEvents[role];
  assert.ok(types?.includes('started')&&types?.includes('delta')&&types?.includes('completed'),
   'Real stream incomplete in '+role);
 }
 assert.equal(new Set(received.stageReceipts.map(x=>x.runId)).size,4);
 assert.equal(received.stageReceipts[2].independentCheck.source,'external_test_runner');
 assert.equal(received.stageReceipts[3].independentCheck.source,'independent_reviewer');
 assert.notEqual(received.stageReceipts[2].independentCheck.examinerId,
  received.stageReceipts[3].independentCheck.examinerId);
 assert.equal(await ssh.requireOk('test -z "$(git -C '+quoteRemote(work.checkoutPath)+
  ' status --porcelain)" && echo CLEAN'),'CLEAN');
 const scope='s19-pipeline:'+work.runId;
 const resultReceipt=await ledger.append({projectId,taskId,runId:work.runId,
  kind:'log',scopeKey:scope,actorId:'s19-resilience-orchestrator',
  content:JSON.stringify(received),
  metadata:{provider:'codex',status:'awaiting_human_approval',runId:work.runId}});
 const verified=await ledger.read(projectId,taskId,resultReceipt.id);
 assert.equal(verified.contentSha256,resultReceipt.contentSha256);
 assert.equal((await ledger.verify(projectId,taskId,'log',scope)).count,1);
 completed=true;
 console.log('S19_LIVE_RESULT='+JSON.stringify({
  status:'PASS',projectId,taskId,runId:work.runId,stageRoles:received.stageReceipts.map(x=>x.role),
  distinctRunIds:4,events:received.modelEvents,
  tokens:received.stageReceipts.map(x=>({role:x.role,input:x.inputTokens,output:x.outputTokens})),
  estimatedTotalUsd:received.estimatedTotalUsd,
  chainSha256:received.chainSha256,independentChecks:received.checkDigests,
  globalUsage:received.globalUsage,controlEvents:received.controlEvents,
  humanApprovalRequired:true,gitIntegrated:false,
  evidenceId:resultReceipt.id,evidenceSha256:resultReceipt.contentSha256
 }));
 }
 }
}catch(e){
 console.error('S19_LIVE_FAILED='+String(e?.message??e).slice(0,240));
 process.exitCode=1;
}finally{
 if(container)try{await ssh.exec('docker rm -f '+quoteRemote(container)+' >/dev/null 2>&1 || true',8000);}catch{/* best-effort Docker cleanup */}
 if(work){
  try{if((await manager.get(projectId,work.runId))?.state==='ready')
   await manager.close(projectId,work.runId);
  }catch(e){console.error('S18_WORKTREE_CLEANUP_FAILED='+String(e).slice(0,150));process.exitCode=1;}
 }
 if(claim)try{await scheduler.complete(projectId,taskId,claim.workerId,claim.leaseToken,claim.fence);}
 catch(e){console.error('S18_LEASE_CLEANUP_FAILED='+String(e).slice(0,150));process.exitCode=1;}
 try{await ssh.requireOk('rm -f '+quoteRemote(runtime+'/input.json')+' '+quoteRemote(runtime+'/fixture-metadata.json'));}catch{/* deleted on next isolated fixture */}
 ssh.close();await pool.end();
 rmSync(temp,{recursive:true,force:true,maxRetries:6,retryDelay:150});
 console.log('S19_LIVE_CLEANUP='+Boolean(work&&completed));
}
