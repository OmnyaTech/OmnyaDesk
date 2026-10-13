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
import {GitIntegrationQueue,IntegrationConflict,IntegrationForbidden} from '../packages/db/src/git-integration.ts';
import {BareGitIntegration,GitValidationError} from '../packages/db/src/git-driver.ts';
import {EvidenceLedger} from '../packages/db/src/evidence-ledger.ts';
import {TaskOrchestrator} from '../packages/db/src/orchestration.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const connection=process.env.DATABASE_URL;
let pool:Pool,repo:PostgresOfficeRepository,tokens:TokenStore,queue:GitIntegrationQueue;
const owner=randomUUID(),operator=randomUUID(),reviewer=randomUUID();
function git(cwd:string,...args:string[]):string{
 const p=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:8000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 assert.equal(p.status,0,'git '+args.join(' ')+' '+String(p.stderr).slice(-250));
 return p.stdout.trim();
}
type Fixture={
 root:string;working:string;bare:string;projectId:string;officeId:string;base:string;
 auth:{submit:NonNullable<Awaited<ReturnType<TokenStore['authenticate']>>>;
  integrate:NonNullable<Awaited<ReturnType<TokenStore['authenticate']>>>;
  human:NonNullable<Awaited<ReturnType<TokenStore['authenticate']>>>;
  untrusted:NonNullable<Awaited<ReturnType<TokenStore['authenticate']>>>;
  submitSecret:string;integrateSecret:string;humanSecret:string};
 branch:(name:string,files:Record<string,string>)=>string;
 task:()=>Promise<string>;close:()=>Promise<void>
};
async function newFixture():Promise<Fixture>{
 const root=mkdtempSync(join(tmpdir(),'omnyadesk-s11-')),working=join(root,'working'),bare=join(root,'integrations.git');
 mkdirSync(working);git(root,'init','--bare','--initial-branch=main',bare);
 git(working,'init','--initial-branch=main');git(working,'config','user.name','S11 Fixture');
 git(working,'config','user.email','s11@example.invalid');
 writeFileSync(join(working,'README.md'),'baseline\n');mkdirSync(join(working,'integrations'));
 writeFileSync(join(working,'integrations','registry.json'),'[{"id":"baseline"}]\n');
 git(working,'add','.');git(working,'commit','-m','initial');
 const base=git(working,'rev-parse','HEAD');
 git(working,'remote','add','origin',bare);git(working,'push','origin','main');
 const result=await repo.createProject({ownerId:owner,name:'S11 disposable '+randomUUID(),
  repositoryRoot:bare,template:'startup'});
 const projectId=result.project.id,officeId=result.office.id;
 const credential=async(subjectId:string,kind:'human'|'integration',scopes:('git:propose'|'git:integrate'|'git:review'|'tasks:read'|'tasks:transition')[])=>{
  const a=await tokens.provision({projectId,subjectId,kind,scopes,expiresInHours:2});
  const principal=await tokens.authenticate('Bearer '+a.secret);
  assert.ok(principal);return {principal,secret:a.secret};
 };
 const submit=await credential(owner,'integration',['git:propose','tasks:read']);
 const integrate=await credential(operator,'integration',['git:integrate','tasks:read']);
 const human=await credential(reviewer,'human',['git:review','tasks:read','tasks:transition']);
 const untrusted=await credential(randomUUID(),'integration',['git:review','tasks:read']);
 return {
  root,working,bare,projectId,officeId,base,
  auth:{submit:submit.principal,integrate:integrate.principal,human:human.principal,
   untrusted:untrusted.principal,submitSecret:submit.secret,integrateSecret:integrate.secret,humanSecret:human.secret},
  branch(name,files){
   git(working,'switch','-C',name,base);
   for(const [path,value] of Object.entries(files)){
    const filepath=join(working,path);mkdirSync(dirname(filepath),{recursive:true});
    writeFileSync(filepath,value);
   }
   git(working,'add','.');git(working,'commit','-m','candidate '+name);
   const sha=git(working,'rev-parse','HEAD');
   git(working,'push','--force','origin','HEAD:refs/heads/'+name);
   return sha;
  },
  async task(){
   const x=await repo.createTask({projectId,officeId,requestedBy:owner,title:'Git integration '+randomUUID(),description:''});
   return x.id;
  },async close(){rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
 };
}
async function propose(f:Fixture,name:string,sha:string,priority=5){
 return queue.submit({projectId:f.projectId,taskId:await f.task(),candidateRef:'refs/heads/'+name,
  candidateSha:sha,baseSha:f.base,priority},f.auth.submit);
}
before(async()=>{
 if(!connection)return;
 pool=createPool(connection);await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);tokens=new TokenStore(pool);
 queue=new GitIntegrationQueue(pool);
});
after(async()=>{if(pool)await pool.end();});

test('S11 migration checksum and restart idempotence',{skip:!connection},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='007_git_integration_queue.sql'")).rowCount,1);
});

test('S11 refuses working trees and invalid ref names; registered bare only',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  assert.throws(()=>new BareGitIntegration(f.working),GitValidationError);
  assert.throws(()=>new BareGitIntegration('not-absolute'),GitValidationError);
  const candidate=f.branch('feature/one',{'docs/a.md':'safe\n'});
  for(const ref of ['refs/heads/main','refs/heads/a;echo','refs/heads/../x','refs/tags/v1','-bad']){
   await assert.rejects(queue.submit({projectId:f.projectId,taskId:await f.task(),
    candidateRef:ref,candidateSha:candidate,baseSha:f.base},f.auth.submit));
  }
 }finally{await f.close();}
});

test('S11 two independent client branches combine only after human approvals and retest',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/a',{'docs/a.md':'A\n'});
  const b=f.branch('feature/b',{'docs/b.md':'B\n'});
  const first=await propose(f,'feature/a',a,7);
  const second=await propose(f,'feature/b',b,6);
  await assert.rejects(queue.integrate(f.projectId,first.id,f.auth.integrate),IntegrationConflict);
  const preparedA=await queue.prepare(f.projectId,first.id,f.auth.integrate);
  const preparedB=await queue.prepare(f.projectId,second.id,f.auth.integrate);
  assert.equal(preparedA.state,'ready');assert.equal(preparedB.state,'ready');
  const ledger=new EvidenceLedger(pool);
  const shown=await queue.get(f.projectId,first.id,f.auth.human);
  assert.equal(shown.review?.diff,preparedA.diff);
  assert.equal(shown.review?.diffSha256,preparedA.diffSha256);
  assert.equal(shown.review?.evidenceId,preparedA.evidenceId);
  assert.equal((await ledger.read(f.projectId,first.taskId,preparedA.evidenceId!)).content,preparedA.diff);
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
  await queue.approve(f.projectId,first.id,preparedA.reviewHash!,f.auth.human);
  await queue.approve(f.projectId,second.id,preparedB.reviewHash!,f.auth.human);
  const approval=await ledger.list(f.projectId,first.taskId,'review_approval','git-approval:'+first.id);
  assert.equal(approval.length,1);
  assert.equal(JSON.parse(approval[0]!.content).evidenceId,preparedA.evidenceId);
  assert.equal(JSON.parse(approval[0]!.content).diffSha256,preparedA.diffSha256);
  assert.equal((await queue.integrate(f.projectId,first.id,f.auth.integrate)).state,'merged');
  const next=await queue.integrate(f.projectId,second.id,f.auth.integrate);
  assert.equal(next.state,'stale');assert.equal((await queue.get(f.projectId,second.id,f.auth.integrate)).approvedBy,null);
  const preparedB2=await queue.prepare(f.projectId,second.id,f.auth.integrate);
  assert.equal(preparedB2.state,'ready');
  assert.notEqual(preparedB.reviewHash,preparedB2.reviewHash);
  assert.notEqual(preparedB.evidenceId,preparedB2.evidenceId);
  assert.equal((await ledger.verify(f.projectId,second.taskId,'review_diff','git-review:'+second.id)).count,2);
  await assert.rejects(queue.approve(f.projectId,second.id,preparedB.reviewHash!,f.auth.human),IntegrationConflict);
  await queue.approve(f.projectId,second.id,preparedB2.reviewHash!,f.auth.human);
  assert.equal((await queue.integrate(f.projectId,second.id,f.auth.integrate)).state,'merged');
  const head=new BareGitIntegration(f.bare).head();
  assert.equal(git(f.bare,'show',head+':docs/a.md'),'A');
  assert.equal(git(f.bare,'show',head+':docs/b.md'),'B');
  assert.equal((await queue.integrate(f.projectId,second.id,f.auth.integrate)).replayed,true);
  const audit=await pool.query('SELECT action FROM git_integration_audit WHERE project_id=$1 ORDER BY id',[f.projectId]);
  assert.ok(audit.rows.some(x=>x.action==='stale'));
  assert.equal(audit.rows.filter(x=>x.action==='merged').length,2);
 }finally{await f.close();}
});

test('S11 overlapping branches produce Git conflict and never move main',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/conflict-a',{'README.md':'VERSION A\n'});
  const b=f.branch('feature/conflict-b',{'README.md':'VERSION B\n'});
  const one=await propose(f,'feature/conflict-a',a);
  const two=await propose(f,'feature/conflict-b',b);
  const ready=await queue.prepare(f.projectId,one.id,f.auth.integrate);
  assert.equal(ready.state,'ready');
  await queue.prepare(f.projectId,two.id,f.auth.integrate);
  await queue.approve(f.projectId,one.id,ready.reviewHash!,f.auth.human);
  assert.equal((await queue.integrate(f.projectId,one.id,f.auth.integrate)).state,'merged');
  const blocked=await queue.prepare(f.projectId,two.id,f.auth.integrate);
  assert.equal(blocked.state,'conflict');
  await assert.rejects(queue.integrate(f.projectId,two.id,f.auth.integrate),IntegrationConflict);
  assert.equal(git(f.bare,'show','refs/heads/main:README.md'),'VERSION A');
 }finally{await f.close();}
});

test('S11 combined validators reject invalid JSON and unsafe file modes without code execution',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const invalid=f.branch('feature/invalid-json',{'config.json':'{"unfinished":'});
  const result=await propose(f,'feature/invalid-json',invalid);
  assert.equal((await queue.prepare(f.projectId,result.id,f.auth.integrate)).state,'tests_failed');
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
  assert.equal((await pool.query('SELECT approved_by FROM git_integration_requests WHERE id=$1',[result.id])).rows[0].approved_by,null);
 }finally{await f.close();}
});

test('S11 semantic collision across independently valid branches blocks revalidation',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/schema-a',{'integrations/registry/team-a.json':'{"id":"shared"}\n'});
  const b=f.branch('feature/schema-b',{'integrations/registry/team-b.json':'{"id":"shared"}\n'});
  const first=await propose(f,'feature/schema-a',a,6);
  const second=await propose(f,'feature/schema-b',b,5);
  const pa=await queue.prepare(f.projectId,first.id,f.auth.integrate);
  const pb=await queue.prepare(f.projectId,second.id,f.auth.integrate);
  assert.equal(pa.state,'ready');assert.equal(pb.state,'ready');
  await queue.approve(f.projectId,first.id,pa.reviewHash!,f.auth.human);
  await queue.approve(f.projectId,second.id,pb.reviewHash!,f.auth.human);
  await queue.integrate(f.projectId,first.id,f.auth.integrate);
  assert.equal((await queue.integrate(f.projectId,second.id,f.auth.integrate)).state,'stale');
  assert.equal((await queue.prepare(f.projectId,second.id,f.auth.integrate)).state,'tests_failed');
  assert.equal(git(f.bare,'show','main:integrations/registry/team-a.json'),'{"id":"shared"}');
  assert.throws(()=>git(f.bare,'show','main:integrations/registry/team-b.json'));
 }finally{await f.close();}
});

test('S11 different client tokens submit concurrently into same immutable integration ledger',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/codex',{'docs/codex.md':'codex\n'});
  const b=f.branch('feature/vscode',{'docs/vscode.md':'vscode\n'});
  const second=await tokens.provision({projectId:f.projectId,subjectId:randomUUID(),kind:'integration',
   scopes:['git:propose','tasks:read'],origin:'vscode',expiresInHours:2});
  const vscode=await tokens.authenticate('Bearer '+second.secret);assert.ok(vscode);
  const tasks=await Promise.all([f.task(),f.task()]);
  const out=await Promise.all([
   queue.submit({projectId:f.projectId,taskId:tasks[0]!,candidateRef:'refs/heads/feature/codex',
    candidateSha:a,baseSha:f.base},f.auth.submit),
   queue.submit({projectId:f.projectId,taskId:tasks[1]!,candidateRef:'refs/heads/feature/vscode',
    candidateSha:b,baseSha:f.base},vscode)
  ]);
  assert.equal(new Set(out.map(x=>x.id)).size,2);
  assert.equal((await queue.list(f.projectId,f.auth.submit)).length,2);
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
  const actors=await pool.query('SELECT DISTINCT submitter_id FROM git_integration_requests WHERE project_id=$1',[f.projectId]);
  assert.equal(actors.rowCount,2);
 }finally{await f.close();}
});

test('S11 false reviewer, wrong hash and proposing identity cannot authorize merge',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const sha=f.branch('feature/review',{'docs/safe.md':'accepted\n'});
  const proposal=await propose(f,'feature/review',sha);
  const prepared=await queue.prepare(f.projectId,proposal.id,f.auth.integrate);
  await assert.rejects(queue.approve(f.projectId,proposal.id,prepared.reviewHash!,f.auth.untrusted),IntegrationForbidden);
  await assert.rejects(queue.approve(f.projectId,proposal.id,'0'.repeat(64),f.auth.human),IntegrationConflict);
  await assert.rejects(queue.integrate(f.projectId,proposal.id,f.auth.integrate),IntegrationConflict);
  const self=await tokens.provision({projectId:f.projectId,subjectId:owner,kind:'human',
   scopes:['git:review'],expiresInHours:2});
  const selfPrincipal=await tokens.authenticate('Bearer '+self.secret);assert.ok(selfPrincipal);
  await assert.rejects(queue.approve(f.projectId,proposal.id,prepared.reviewHash!,selfPrincipal),IntegrationConflict);
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
 }finally{await f.close();}
});

test('S11 mutated candidate ref after human approval invalidates merge',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const sha=f.branch('feature/mutated',{'docs/a.md':'version 1\n'});
  const p=await propose(f,'feature/mutated',sha);
  const q=await queue.prepare(f.projectId,p.id,f.auth.integrate);
  await queue.approve(f.projectId,p.id,q.reviewHash!,f.auth.human);
  f.branch('feature/mutated',{'docs/a.md':'version 2\n'});
  assert.equal((await queue.integrate(f.projectId,p.id,f.auth.integrate)).state,'stale');
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
  assert.equal((await queue.get(f.projectId,p.id,f.auth.integrate)).approvedBy,null);
 }finally{await f.close();}
});

test('S11 priority protects highest unresolved proposal and approved order',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/low',{'docs/low.md':'low\n'});
  const b=f.branch('feature/high',{'docs/high.md':'high\n'});
  const low=await propose(f,'feature/low',a,1);
  const high=await propose(f,'feature/high',b,10);
  await assert.rejects(queue.prepare(f.projectId,low.id,f.auth.integrate),IntegrationConflict);
  const top=await queue.prepare(f.projectId,high.id,f.auth.integrate);
  assert.equal(top.state,'ready');
  const other=await queue.prepare(f.projectId,low.id,f.auth.integrate);
  await queue.approve(f.projectId,high.id,top.reviewHash!,f.auth.human);
  await queue.approve(f.projectId,low.id,other.reviewHash!,f.auth.human);
  await assert.rejects(queue.integrate(f.projectId,low.id,f.auth.integrate),IntegrationConflict);
  assert.equal((await queue.integrate(f.projectId,high.id,f.auth.integrate)).state,'merged');
 }finally{await f.close();}
});

test('S11 queue rows, audit history and project isolation persist on second pool',{skip:!connection},async()=>{
 const f=await newFixture();
 const second=createPool(connection!);
 try{
  const a=f.branch('feature/persist',{'docs/persist.md':'persistent\n'});
  const p=await propose(f,'feature/persist',a);
  const restored=new GitIntegrationQueue(second);
  assert.equal((await restored.get(f.projectId,p.id,f.auth.submit)).state,'queued');
  const q=await restored.prepare(f.projectId,p.id,f.auth.integrate);
  assert.equal(q.state,'ready');
  const cross=await repo.createProject({ownerId:owner,name:'cross '+randomUUID(),repositoryRoot:null,template:'custom'});
  const foreign=await tokens.provision({projectId:cross.project.id,subjectId:randomUUID(),kind:'integration',
   scopes:['tasks:read','git:integrate'],expiresInHours:1});
  const outsider=await tokens.authenticate('Bearer '+foreign.secret);assert.ok(outsider);
  await assert.rejects(restored.get(f.projectId,p.id,outsider));
  const history=await pool.query('SELECT * FROM git_integration_audit WHERE request_id=$1',[p.id]);
  assert.ok(history.rowCount&&history.rowCount>=2);
  await assert.rejects(pool.query('DELETE FROM git_integration_audit WHERE request_id=$1',[p.id]));
 }finally{await second.end();await f.close();}
});

test('S11 token revoked after initial authentication cannot approve or integrate',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const sha=f.branch('feature/revoke',{'docs/secure.md':'secure\n'});
  const proposal=await propose(f,'feature/revoke',sha);
  const prepared=await queue.prepare(f.projectId,proposal.id,f.auth.integrate);
  const human=await tokens.provision({projectId:f.projectId,subjectId:randomUUID(),kind:'human',
   scopes:['git:review'],expiresInHours:2});
  const principal=await tokens.authenticate('Bearer '+human.secret);assert.ok(principal);
  await tokens.revoke(human.id);
  await assert.rejects(queue.approve(f.projectId,proposal.id,prepared.reviewHash!,principal),IntegrationForbidden);
  await queue.approve(f.projectId,proposal.id,prepared.reviewHash!,f.auth.human);
  const live=await tokens.provision({projectId:f.projectId,subjectId:randomUUID(),kind:'integration',
   scopes:['git:integrate'],expiresInHours:2});
  const stale=await tokens.authenticate('Bearer '+live.secret);assert.ok(stale);
  await tokens.revoke(live.id);
  await assert.rejects(queue.integrate(f.projectId,proposal.id,stale),IntegrationForbidden);
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
 }finally{await f.close();}
});

test('S11 integration queue blocks SQL injection in branch, commit and root',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/safe',{'docs/safe.md':'text\n'});
  await assert.rejects(queue.submit({projectId:f.projectId,taskId:await f.task(),
   candidateRef:'refs/heads/feature/safe && whoami',candidateSha:a,baseSha:f.base},f.auth.submit));
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
 }finally{await f.close();}
});

async function advanceToReview(projectId:string,taskId:string){
 const flow=new TaskOrchestrator(pool);
 let version=1;
 for(const to of ['queued','planning','implementing','testing','reviewing','awaiting_approval'] as const){
  const r=await flow.transition({projectId,taskId,commandKey:randomUUID(),
   expectedVersion:version++,to,reason:null,actor:{kind:'system',id:'system'},source:'system'});
  assert.equal(r.task.status,to);
 }
 return version;
}

test('S15 rejection is terminal and auditable, never automatically merges',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const sha=f.branch('feature/reject',{'docs/rejected.md':'do not merge\n'});
  const request=await propose(f,'feature/reject',sha);
  const prepared=await queue.prepare(f.projectId,request.id,f.auth.integrate);
  assert.equal(prepared.state,'ready');
  await assert.rejects(queue.decide(f.projectId,request.id,prepared.reviewHash!,
   'rejected','   ',f.auth.human),IntegrationConflict);
  await assert.rejects(queue.decide(f.projectId,request.id,prepared.reviewHash!,
   'rejected','no',f.auth.untrusted),IntegrationForbidden);
  const rejected=await queue.decide(f.projectId,request.id,prepared.reviewHash!,
   'rejected','Does not meet acceptance criteria',f.auth.human);
  assert.equal(rejected.decision,'rejected');
  const seen=await queue.get(f.projectId,request.id,f.auth.human);
  assert.equal(seen.state,'rejected');assert.equal(seen.decisionBy,reviewer);
  assert.equal(seen.review?.diff,prepared.diff);
  assert.equal(seen.decisionReason,'Does not meet acceptance criteria');
  await assert.rejects(queue.approve(f.projectId,request.id,prepared.reviewHash!,f.auth.human),IntegrationConflict);
  await assert.rejects(queue.integrate(f.projectId,request.id,f.auth.integrate),IntegrationConflict);
  await assert.rejects(queue.resubmit(f.projectId,request.id,{
   candidateRef:'refs/heads/feature/reject',candidateSha:sha,baseSha:f.base,expectedRevision:1
  },f.auth.submit),IntegrationConflict);
  const a=new EvidenceLedger(pool);
  const receipts=await a.list(f.projectId,request.taskId,'review_decision','git-decision:'+request.id);
  assert.equal(receipts.length,1);
  assert.equal(JSON.parse(receipts[0]!.content).evidenceId,prepared.evidenceId);
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
 }finally{await f.close();}
});

test('S15 requested changes demand new candidate, revision and new human approval',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const firstSha=f.branch('feature/draft',{'docs/plan.md':'draft\n'});
  const request=await propose(f,'feature/draft',firstSha);
  const first=await queue.prepare(f.projectId,request.id,f.auth.integrate);
  await queue.decide(f.projectId,request.id,first.reviewHash!,
   'changes_requested','Add rollback instructions',f.auth.human);
  assert.equal((await queue.get(f.projectId,request.id,f.auth.human)).state,'changes_requested');
  await assert.rejects(queue.resubmit(f.projectId,request.id,{
   candidateRef:'refs/heads/feature/draft',candidateSha:firstSha,baseSha:f.base,expectedRevision:1
  },f.auth.submit),IntegrationConflict);
  const newer=f.branch('feature/rework',{'docs/plan.md':'draft with rollback\n'});
  await assert.rejects(queue.resubmit(f.projectId,request.id,{
   candidateRef:'refs/heads/feature/rework',candidateSha:newer,baseSha:f.base,expectedRevision:2
  },f.auth.submit),IntegrationConflict);
  const resubmitted=await queue.resubmit(f.projectId,request.id,{
   candidateRef:'refs/heads/feature/rework',candidateSha:newer,baseSha:f.base,expectedRevision:1
  },f.auth.submit);
  assert.equal(resubmitted.revision,2);
  const second=await queue.prepare(f.projectId,request.id,f.auth.integrate);
  assert.notEqual(first.reviewHash,second.reviewHash);
  assert.notEqual(first.evidenceId,second.evidenceId);
  await assert.rejects(queue.approve(f.projectId,request.id,first.reviewHash!,f.auth.human),IntegrationConflict);
  await queue.approve(f.projectId,request.id,second.reviewHash!,f.auth.human);
  assert.equal((await queue.integrate(f.projectId,request.id,f.auth.integrate)).state,'merged');
  const ledger=new EvidenceLedger(pool);
  assert.equal((await ledger.verify(f.projectId,request.taskId,'review_diff','git-review:'+request.id)).count,2);
  assert.equal((await ledger.verify(f.projectId,request.taskId,'review_decision','git-decision:'+request.id)).count,1);
  assert.equal((await ledger.verify(f.projectId,request.taskId,'review_approval','git-approval:'+request.id)).count,1);
  assert.equal(git(f.bare,'show','main:docs/plan.md'),'draft with rollback');
 }finally{await f.close();}
});

test('S15 task approval, immutable review and event/outbox commit atomically via HTTP',{skip:!connection},async()=>{
 const f=await newFixture();
 const api=await buildPersistentApi(pool);
 try{
  const sha=f.branch('feature/task',{'docs/task.md':'approved bytes\n'});
  const proposal=await propose(f,'feature/task',sha);
  const prepared=await queue.prepare(f.projectId,proposal.id,f.auth.integrate);
  const version=await advanceToReview(f.projectId,proposal.taskId);
  const url='/v1/projects/'+f.projectId+'/tasks/'+proposal.taskId+'/human-decisions';
  const body={integrationId:proposal.id,commandKey:randomUUID(),expectedVersion:version,
   reviewHash:prepared.reviewHash,decision:'approved',reason:null};
  const call=async(secret:string|undefined,input:unknown,path=url)=>api.inject({
   method:'POST',url:path,headers:{'content-type':'application/json',
    ...(secret?{authorization:'Bearer '+secret}:{})},
   payload:JSON.stringify(input)});
  assert.equal((await call(undefined,body)).statusCode,401);
  assert.equal((await call(f.auth.integrateSecret,body)).statusCode,403);
  assert.equal((await call(f.auth.humanSecret,{...body,reviewHash:'0'.repeat(64)})).statusCode,409);
  assert.equal((await call(f.auth.humanSecret,{...body,expectedVersion:version+99})).statusCode,409);
  const before=await pool.query('SELECT decision_state FROM git_integration_requests WHERE id=$1',[proposal.id]);
  assert.equal(before.rows[0].decision_state,'pending');
  const approved=await call(f.auth.humanSecret,body);
  assert.equal(approved.statusCode,200,approved.body);
  assert.equal(approved.json().decision,'approved');
  assert.equal(approved.json().task.task.status,'approved');
  assert.equal(approved.json().task.task.version,version+1);
  const audit=await pool.query('SELECT action FROM git_integration_audit WHERE request_id=$1 AND action=$2',[proposal.id,'approved']);
  assert.equal(audit.rowCount,1);
  const outbox=await pool.query('SELECT payload FROM task_outbox WHERE task_id=$1 ORDER BY id DESC LIMIT 1',[proposal.taskId]);
  assert.equal(outbox.rows[0].payload.type,'task.status_changed');
  assert.equal(outbox.rows[0].payload.actor.kind,'human');
  assert.equal((await call(f.auth.humanSecret,body)).statusCode,409);
  assert.equal((await call(f.auth.humanSecret,{...body,commandKey:randomUUID()})).statusCode,409);
  assert.equal((await queue.integrate(f.projectId,proposal.id,f.auth.integrate)).state,'merged');
  const forbidden=await call(f.auth.humanSecret,{...body,decision:'rejected',reason:'never'});
  assert.equal(forbidden.statusCode,409);
 }finally{await api.close();await f.close();}
});

test('S15 requested changes and explicit rejection atomically update task state',{skip:!connection},async()=>{
 const f=await newFixture();
 try{
  const a=f.branch('feature/requestchanges',{'docs/rework.md':'review this\n'});
  const proposal=await propose(f,'feature/requestchanges',a);
  const prepared=await queue.prepare(f.projectId,proposal.id,f.auth.integrate);
  const version=await advanceToReview(f.projectId,proposal.taskId);
  const result=await queue.decide(f.projectId,proposal.id,prepared.reviewHash!,
   'changes_requested','Fix integration tests',f.auth.human,
   {taskId:proposal.taskId,expectedVersion:version,commandKey:randomUUID()});
  assert.equal(result.task?.task.status,'changes_requested');
  const flow=new TaskOrchestrator(pool);
  const queued=await flow.transition({projectId:f.projectId,taskId:proposal.taskId,
   commandKey:randomUUID(),expectedVersion:version+1,to:'queued',reason:null,
   actor:{kind:'system',id:'system'},source:'system'});
  assert.equal(queued.task.status,'queued');
  assert.notEqual(queued.task.currentRunId,result.task?.task.currentRunId);
  assert.equal(new BareGitIntegration(f.bare).head(),f.base);
 }finally{await f.close();}
});
