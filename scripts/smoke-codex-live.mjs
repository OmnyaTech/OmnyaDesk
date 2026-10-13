import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {ResourceScheduler} from '../dist/packages/db/src/scheduler.js';
import {UbuntuSshTransport,quoteRemote} from '../dist/packages/db/src/remote-ubuntu.js';
import {RemoteWorktreeManager} from '../dist/packages/db/src/remote-worktrees.js';
import {EvidenceLedger} from '../dist/packages/db/src/evidence-ledger.js';

// Opt-in only: never runs in public CI or pnpm check; requires actual ChatGPT device login.
if(process.env.OMNYA_S17_LIVE!=='1'||!process.env.DATABASE_URL||!process.env.OMNYA_S12_REMOTE_CONFIG)
 throw Error('Explicit OMNYA_S17_LIVE=1, DATABASE_URL and private Ubuntu config required');
const pool=createPool(process.env.DATABASE_URL);
const repository=new PostgresOfficeRepository(pool),scheduler=new ResourceScheduler(pool);
const ssh=new UbuntuSshTransport(JSON.parse(readFileSync(process.env.OMNYA_S12_REMOTE_CONFIG,'utf8')));
const manager=new RemoteWorktreeManager(pool,ssh),ledger=new EvidenceLedger(pool);
const local=mkdtempSync(join(tmpdir(),'omnyadesk-s17-live-'));
const source=join(local,'sample'),bare=join(local,'origin.git');
const root=process.env.OMNYA_S17_RUNTIME_ROOT;
if(!root||!/^\/home\/[a-z_][a-z0-9_-]*\/\.local\/share\/omnyadesk\/s17$/.test(root))
 throw Error('OMNYA_S17_RUNTIME_ROOT must reference trusted Ubuntu S17 root');
const approvedRoot=root.slice(0,-4)+'/s12/projects';
const pilot=root+'/runtime/pilot';
let projectId,taskId,work,claim,container,success=false,stored;
function git(where,...argv){
 const result=spawnSync('git',['-C',where,...argv],{encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,'Git fixture error: '+argv.join(' '));
 return result.stdout.trim();
}
try{
 await ssh.connect();
 git(local,'init','--bare','--initial-branch=main',bare);
 mkdirSync(source);git(source,'init','--initial-branch=main');
 git(source,'config','user.name','S17 disposable test');
 git(source,'config','user.email','s17@example.invalid');
 writeFileSync(join(source,'entry.sh'),'#!/bin/sh\necho SYNTHETIC_S17_FIXTURE\n');
 writeFileSync(join(source,'README.md'),'S17 isolated synthetic demonstration. Output: OMNYADESK_S17_PILOT_OK. No secrets or personal data.\n');
 git(source,'add','.');git(source,'commit','-m','Synthetic Codex pilot');
 const sha=git(source,'rev-parse','HEAD');
 git(source,'remote','add','origin',bare);git(source,'push','origin','main');
 const project=await repository.createProject({ownerId:randomUUID(),
  name:'S17 disposable Codex pilot '+randomUUID(),repositoryRoot:bare,template:'custom'});
 projectId=project.project.id;
 const t=await repository.createTask({projectId,officeId:project.office.id,
  requestedBy:randomUUID(),title:'S17 synthetic read only',description:''});
 taskId=t.id;
 await scheduler.register({projectId,taskId,resources:[{key:'repo',mode:'write'}],priority:3,dependsOn:[]});
 claim=await scheduler.claim(projectId,'s17-codex-pilot-'+randomUUID(),85000);
 assert.ok(claim,'S10 scheduler denied lease');
 work=await manager.create({projectId,taskId,baseSha:sha});
 assert.equal((await manager.get(projectId,work.runId))?.state,'ready');
 const runDir=work.checkoutPath.slice(0,-'/workspace'.length);
 const request={projectId,taskId,runId:work.runId,
  role:'developer',prompt:'Read README.md in this disposable example. Respond with only: OMNYADESK_S17_PILOT_OK. Do not modify files or use any tools.',
  workspacePath:work.checkoutPath,sandboxId:'codex-'+work.runId,
  modelId:process.env.OMNYA_S17_CODEX_MODEL||'default',
  allowedTools:[],maxSteps:32,maxCostUsd:0.1};
 await ssh.requireOk('mkdir -p '+quoteRemote(pilot+'/packages/adapters/src')+' '+
  quoteRemote(pilot+'/packages/contracts/src'));
 const files=[
  ['dist/packages/adapters/src/codex.js','packages/adapters/src/codex.js'],
  ['dist/packages/contracts/src/provider.js','packages/contracts/src/provider.js'],
  ['dist/packages/contracts/src/domain.js','packages/contracts/src/domain.js'],
  ['scripts/codex-live-guest.mjs','guest.mjs']
 ];
 for(const [from,to] of files)await ssh.upload(join(process.cwd(),from),pilot+'/'+to);
 const reqfile=join(local,'request.json');
 writeFileSync(reqfile,JSON.stringify(request)+'\n');
 await ssh.upload(reqfile,pilot+'/request.json');
 container='omnyadesk-s17-'+work.runId;
 // The source.git mount is needed to resolve Git worktree's .git pointer.
 // This command changes no Docker networks and never touches production containers.
 const remote=`set -eu
root=${root}
checkout=${work.checkoutPath}
rundir=${runDir}
name=${container}
test -d "$checkout" && test -d "$rundir/source.git"
authip=$(getent ahostsv4 auth.openai.com | awk 'NR==1{print $1}')
apiip=$(getent ahostsv4 api.openai.com | awk 'NR==1{print $1}')
test -n "$authip" && test -n "$apiip"
exec docker run --rm --name "$name" --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 1024m --cpus 1 --network bridge --tmpfs /tmp:rw,nosuid,nodev,size=64m --add-host "auth.openai.com:$authip" --add-host "api.openai.com:$apiip" -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt -e HOME=/auth -e CODEX_HOME=/auth -e OMNYA_S17_APPROVED_WORKSPACE_ROOT=${approvedRoot} -v "$root/runtime:/runtime:ro" -v "$root/auth:/auth:rw" -v "$checkout:$checkout:ro" -v "$rundir/source.git:$rundir/source.git:ro" -w /runtime/pilot --label com.omnyadesk.sprint=S17 --label com.omnyadesk.run=${work.runId} node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 node /runtime/pilot/guest.mjs`;
 const output=await ssh.exec(remote,90000);
 const line=output.stdout.split(/\r?\n/).find(x=>x.startsWith('S17_PILOT_RECEIPT='));
 if(!line){
  console.log('S17_DIAGNOSTIC='+JSON.stringify({exitCode:output.exitCode,
   stdoutTags:output.stdout.split(/\r?\n/).filter(x=>/^(S17_|Error:|Node\.js|TypeError|npm ERR)/.test(x)).slice(0,10),
   stderrTags:output.stderr.match(/S17_[A-Z_]+=[A-Z_]+/g)?.slice(0,8)??[]}));
  throw Error('Live Codex receipt missing');
 }
 const receipt=JSON.parse(line.slice('S17_PILOT_RECEIPT='.length));
 if(receipt.status!=='completed'){
  const categories=output.stderr.match(/S17_SDK_FAILURE_CATEGORY=[A-Z_]+/g)??[];
  console.log('S17_SAFE_DIAGNOSTIC='+JSON.stringify({exitCode:output.exitCode,
   sdkFailureCategories:categories,
   sdkSummary:(output.stderr.match(/S17_SDK_FAILURE_SUMMARY=([^\r\n]*)/)??[])[1]??null,
   turnFailure:(output.stderr.match(/S17_CODEX_TURN_FAILED=([^\r\n]*)/)??[])[1]??null,
   receiptCode:receipt.errorCode,
   eventTypes:receipt.eventTypes}));
 }
 assert.equal(output.exitCode,0,'Provider failed with '+receipt.errorCode);
 assert.equal(receipt.status,'completed');
 for(const field of ['projectId','taskId','runId'])assert.equal(receipt[field],request[field]);
 assert.ok(receipt.eventTypes.includes('started')&&receipt.eventTypes.includes('completed'));
 assert.ok(receipt.eventTypes.includes('delta'),'Real stream contained no delta');
 assert.deepEqual(receipt.sequence,receipt.sequence.map((_,i)=>i+1));
 assert.equal(receipt.artifacts,0);
 assert.ok(receipt.outputLength>0&&receipt.outputSha256.match(/^[a-f0-9]{64}$/));
 assert.ok(receipt.usage.inputTokens>0&&receipt.usage.outputTokens>0);
 assert.ok(receipt.usage.costUsd>0&&receipt.usage.costUsd<=0.1);
 assert.equal(await ssh.requireOk('test -z "$(git -C '+quoteRemote(work.checkoutPath)+
  ' status --porcelain)" && echo CLEAN'),'CLEAN');
 stored=await ledger.append({projectId,taskId,runId:work.runId,kind:'log',
  scopeKey:'provider:codex:'+work.runId,actorId:'codex-provider',
  content:JSON.stringify({...receipt,pricingBasis:'synthetic operator estimates, not billed cost'}),
  metadata:{provider:'codex',status:'completed',runId:work.runId}});
 const verified=await ledger.read(projectId,taskId,stored.id);
 assert.equal(verified.contentSha256,stored.contentSha256);
 assert.equal((await ledger.verify(projectId,taskId,'log','provider:codex:'+work.runId)).count,1);
 success=true;
 console.log('S17_LIVE_RESULT='+JSON.stringify({status:'PASS',projectId,taskId,runId:work.runId,
  streamEvents:receipt.eventTypes,usage:receipt.usage,outputSha256:receipt.outputSha256,
  evidenceId:stored.id,evidenceSha256:stored.contentSha256}));
}catch(e){
 console.error('S17_LIVE_FAILED='+String(e?.message||e).slice(0,350));
 process.exitCode=1;
}finally{
 if(container){
  try{await ssh.exec('docker rm -f '+quoteRemote(container)+' >/dev/null 2>&1 || true',8000)}catch{/* best-effort container teardown */}
 }
 if(work){
  try{
   // No reset of an unauthorized dirty checkout.
   if((await manager.get(projectId,work.runId))?.state==='ready')
    await manager.close(projectId,work.runId);
  }catch(err){console.error('S17_WORKTREE_CLEANUP_ERROR='+String(err).slice(0,180));process.exitCode=1;}
 }
 if(claim){
  try{await scheduler.complete(projectId,taskId,claim.workerId,claim.leaseToken,claim.fence);}
  catch(err){console.error('S17_SCHEDULER_CLEANUP_ERROR='+String(err).slice(0,180));process.exitCode=1;}
 }
 try{await ssh.requireOk('rm -f '+quoteRemote(pilot+'/request.json'))}catch{/* request fixture removed on next sandbox replacement */}
 ssh.close();
 await pool.end();
 rmSync(local,{recursive:true,force:true,maxRetries:6,retryDelay:150});
 console.log('S17_LIVE_CLEANUP='+String(Boolean(work&&success)));
}
