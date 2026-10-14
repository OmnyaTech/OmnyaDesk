import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {after,before,test} from 'node:test';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {MockProvider} from '../packages/adapters/src/mock.ts';
import {TaskOrchestrator} from '../packages/db/src/orchestration.ts';
import {GitIntegrationQueue} from '../packages/db/src/git-integration.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';
import {EvidenceLedger} from '../packages/db/src/evidence-ledger.ts';

const db=process.env.DATABASE_URL;
let pool:Pool;
before(async()=>{if(db){pool=createPool(db);await runMigrations(pool);}});
after(async()=>{if(pool)await pool.end();});
function git(cwd:string,...args:string[]):string{
 const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:12000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 assert.equal(r.status,0,'git '+args.join(' ')+' '+String(r.stderr).slice(-200));
 return r.stdout.trim();
}

test('S29 MVP synthetic provider -> isolated Git diff -> API review -> atomic human approval -> VS Code read-only feed',{skip:!db},async()=>{
 const root=mkdtempSync(join(tmpdir(),'omnya-s29-e2e-'));
 const working=join(root,'workspace'),bare=join(root,'git.git');
 let api:Awaited<ReturnType<typeof buildPersistentApi>>|undefined;
 try{
  mkdirSync(working);git(root,'init','--bare','--initial-branch=main',bare);
  git(working,'init','--initial-branch=main');
  git(working,'config','user.name','S29 fixture');git(working,'config','user.email','s29@example.invalid');
  writeFileSync(join(working,'README.md'),'baseline\n');
  mkdirSync(join(working,'integrations'));
  writeFileSync(join(working,'integrations','registry.json'),'[{"id":"baseline"}]\n');
  git(working,'add','.');git(working,'commit','-m','Initial');
  const base=git(working,'rev-parse','HEAD');
  git(working,'remote','add','origin',bare);git(working,'push','origin','main');
  const repo=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool),queue=new GitIntegrationQueue(pool);
  const owner=randomUUID(),reviewer=randomUUID();
  const {project,office}=await repo.createProject({
   ownerId:owner,name:'S29 synthetic E2E '+randomUUID(),repositoryRoot:bare,template:'startup'});
  const projectId=project.id;
  const cred=async(subjectId:string,kind:'human'|'integration',scopes:('projects:read'|'tasks:read'|'tasks:create'|'tasks:transition'|'events:read'|'git:review'|'git:integrate'|'git:propose')[])=>
   tokens.provision({projectId,subjectId,kind,scopes,expiresInHours:1,origin:'vscode'});
  const writer=await cred(owner,'integration',['tasks:create','tasks:read','git:propose','events:read']);
  const manager=await cred(owner,'integration',['git:integrate','tasks:read']);
  const human=await cred(reviewer,'human',['tasks:read','tasks:transition','git:review','events:read']);
  const vscodeRead=await cred(reviewer,'human',['projects:read','tasks:read','events:read']);
  const principal=async(secret:string)=>{const value=await tokens.authenticate('Bearer '+secret);assert.ok(value);return value;};
  api=await buildPersistentApi(pool);
  const call=async(method:'GET'|'POST',path:string,secret:string,body?:unknown,headers?:Record<string,string>)=>{
   const res=await api!.inject({method,url:path,headers:{authorization:'Bearer '+secret,
    ...(body?{'content-type':'application/json'}:{}),...headers},
    ...(body?{payload:JSON.stringify(body)}:{})});
   return res;
  };
  const intake=await call('POST','/v1/projects/'+projectId+'/intake',writer.secret,
   {officeId:office.id,title:'S29 E2E Synthetic Developer',description:'Read-only VS Code diff review'},
   {'idempotency-key':randomUUID()});
  assert.equal(intake.statusCode,201,intake.body);
  const taskId=intake.json().task.id;
  const runId=randomUUID();
  const result=await new MockProvider({chunks:['S29_SAFE_SYNTHETIC_AGENT_DIFF']} ).run({
   projectId,taskId,runId,role:'developer',prompt:'Create synthetic isolated fixture',
   workspacePath:'/sandbox/worktree',sandboxId:'s29-mvp',modelId:'mock-v1',
   allowedTools:[],maxSteps:8,maxCostUsd:0
  },new AbortController().signal);
  assert.equal(result.output,'S29_SAFE_SYNTHETIC_AGENT_DIFF');
  // Mock output is explicitly synthetic. Git candidate is prepared in a disposable local repository,
  // not written by the model, then verified by real Git integration before any review.
  git(working,'switch','-C','feature/mvp-review',base);
  const filename=join(working,'docs','agent-review.txt');mkdirSync(dirname(filename),{recursive:true});
  writeFileSync(filename,result.output+'\n<script>alert("untrusted")</script>\n');
  git(working,'add','.');git(working,'commit','-m','S29 deterministic mock provider fixture');
  const sha=git(working,'rev-parse','HEAD');
  git(working,'push','--force','origin','HEAD:refs/heads/feature/mvp-review');
  const proposal=await queue.submit({projectId,taskId,baseSha:base,candidateSha:sha,
   candidateRef:'refs/heads/feature/mvp-review',priority:5},await principal(writer.secret));
  const prepared=await queue.prepare(projectId,proposal.id,await principal(manager.secret));
  assert.equal(prepared.state,'ready');
  assert.ok(prepared.diff?.includes('S29_SAFE_SYNTHETIC_AGENT_DIFF'));
  const uri='/v1/projects/'+projectId;
  // Only tasks:read: the same permission used by VS Code SecretStorage gateway.
  const listing=await call('GET',uri+'/git/integrations',vscodeRead.secret);
  assert.equal(listing.statusCode,200);
  const diff=await call('GET',uri+'/git/integrations/'+proposal.id,vscodeRead.secret);
  assert.equal(diff.statusCode,200);
  assert.equal(diff.json().integration.reviewHash,prepared.reviewHash);
  assert.ok(diff.json().integration.review.diff.includes('<script>alert('));
  assert.ok(!JSON.stringify(diff.json()).includes(writer.secret));
  const blocked=await call('POST',uri+'/tasks/'+taskId+'/human-decisions',vscodeRead.secret,{
   integrationId:proposal.id,commandKey:randomUUID(),expectedVersion:1,
   reviewHash:prepared.reviewHash,decision:'approved',reason:null});
  assert.equal(blocked.statusCode,403);
  const workflow=new TaskOrchestrator(pool);
  let version=1;
  for(const to of ['queued','planning','implementing','testing','reviewing','awaiting_approval'] as const){
   const value=await workflow.transition({projectId,taskId,expectedVersion:version++,
    commandKey:randomUUID(),to,reason:null,source:'system',actor:{kind:'system',id:'system'}});
   assert.equal(value.task.status,to);
  }
  const approved=await call('POST',uri+'/tasks/'+taskId+'/human-decisions',human.secret,{
   integrationId:proposal.id,commandKey:randomUUID(),expectedVersion:version,
   reviewHash:prepared.reviewHash,decision:'approved',reason:null
  });
  assert.equal(approved.statusCode,200,approved.body);
  assert.equal(approved.json().task.task.status,'approved');
  const web=await call('GET',uri+'/tasks',vscodeRead.secret);
  assert.equal(web.json().tasks.find((x:{id:string})=>x.id===taskId).status,'approved');
  const readEvents=await call('GET',uri+'/events?after=0',vscodeRead.secret);
  assert.equal(readEvents.statusCode,200);
  assert.ok(readEvents.json().events.some((e:{type:string;actor:{kind:string}})=>e.type==='task.status_changed'&&e.actor.kind==='human'));
  const evidence=new EvidenceLedger(pool);
  assert.equal((await evidence.verify(projectId,taskId,'review_diff','git-review:'+proposal.id)).count,1);
  assert.equal((await evidence.verify(projectId,taskId,'review_approval','git-approval:'+proposal.id)).count,1);
  assert.equal(git(bare,'rev-parse','refs/heads/main'),base,'approval must never auto-merge');
  const mismatched=await call('GET','/v1/projects/'+randomUUID()+'/git/integrations/'+proposal.id,vscodeRead.secret);
  assert.equal(mismatched.statusCode,404);
 }finally{
  if(api)await api.close();
  rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:200});
 }
});
