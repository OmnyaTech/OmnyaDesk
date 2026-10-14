import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {GitIntegrationQueue} from '../packages/db/src/git-integration.ts';
import {TaskOrchestrator} from '../packages/db/src/orchestration.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';
// @ts-expect-error executable CLI ESM is intentionally not part of TypeScript build
import {executeCli} from '../apps/cli/src/client.mjs';
function git(cwd:string,...args:string[]):string{
 const output=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:9000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 assert.equal(output.status,0,'git '+args.join(' ')+': '+String(output.stderr).slice(-200));
 return output.stdout.trim();
}
test('S28 real Git review approval through CLI atomically matches Web, ledger and version',{skip:!process.env.DATABASE_URL},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'omnyadesk-s28-'));
 const working=join(dir,'working'),bare=join(dir,'bare.git');
 const pool=createPool(process.env.DATABASE_URL!);
 let api:Awaited<ReturnType<typeof buildPersistentApi>>|null=null;
 try{
  await runMigrations(pool);
  const repo=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool),queue=new GitIntegrationQueue(pool);
  mkdirSync(working);
  git(dir,'init','--bare','--initial-branch=main',bare);
  git(working,'init','--initial-branch=main');git(working,'config','user.name','S28 Test');
  git(working,'config','user.email','s28@example.invalid');
  writeFileSync(join(working,'README.md'),'baseline\n');
  mkdirSync(join(working,'integrations'));writeFileSync(join(working,'integrations','registry.json'),'[{"id":"baseline"}]\n');
  git(working,'add','.');git(working,'commit','-m','base');
  const base=git(working,'rev-parse','HEAD');
  git(working,'remote','add','origin',bare);git(working,'push','origin','main');
  const owner=randomUUID(),human=randomUUID();
  const p=await repo.createProject({ownerId:owner,name:'S28 approval '+randomUUID(),repositoryRoot:bare,template:'startup'});
  const projectId=p.project.id;
  const grant=async(subjectId:string,kind:'human'|'integration',scopes:('projects:read'|'tasks:read'|'tasks:create'|'tasks:transition'|'git:propose'|'git:integrate'|'git:review'|'events:read')[])=>{
   const t=await tokens.provision({projectId,subjectId,kind,scopes,expiresInHours:1,origin:'cli'});
   const auth=await tokens.authenticate('Bearer '+t.secret);assert.ok(auth);
   return {secret:t.secret,principal:auth};
  };
  const create=await grant(owner,'integration',['tasks:create','tasks:read','projects:read','events:read','git:propose']);
  const integrate=await grant(owner,'integration',['git:integrate','tasks:read']);
  const reviewer=await grant(human,'human',['git:review','tasks:transition','tasks:read','events:read']);
  api=await buildPersistentApi(pool);
  const run=(argv:string[],token:string)=>{
   return executeCli(argv,{token,fetcher:async(url:string,init:RequestInit)=>{
    const u=new URL(url);
    const response=await api!.inject({method:init.method as 'GET'|'POST',url:u.pathname+u.search,
     headers:init.headers as Record<string,string>,payload:init.body as string|undefined});
    return {status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,json:async()=>response.json()};
   }});
  };
  const task=await run(['create',projectId,p.office.id,'Revisar integração CLI','Mesma origem do painel'],create.secret);
  const taskId=task.result.task.id;
  git(working,'switch','-C','feature/s28',base);
  const target=join(working,'docs','changes.md');mkdirSync(dirname(target),{recursive:true});
  writeFileSync(target,'approved through CLI\n');
  git(working,'add','.');git(working,'commit','-m','review candidate');
  const sha=git(working,'rev-parse','HEAD');
  git(working,'push','--force','origin','HEAD:refs/heads/feature/s28');
  const proposal=await queue.submit({projectId,taskId,candidateRef:'refs/heads/feature/s28',
   candidateSha:sha,baseSha:base,priority:4},create.principal);
  const prepared=await queue.prepare(projectId,proposal.id,integrate.principal);
  assert.ok(prepared.reviewHash);
  const flow=new TaskOrchestrator(pool);
  let version=1;
  for(const to of ['queued','planning','implementing','testing','reviewing','awaiting_approval'] as const){
   const updated=await flow.transition({projectId,taskId,commandKey:randomUUID(),expectedVersion:version++,
    to,reason:null,actor:{kind:'system',id:'system'},source:'system'});
   assert.equal(updated.task.status,to);
  }
  const summaries=await run(['reviews',projectId],reviewer.secret);
  assert.ok(summaries.result.integrations.some((x:{id:string})=>x.id===proposal.id));
  const review=await run(['review',projectId,proposal.id],reviewer.secret);
  assert.equal(review.result.integration.reviewHash,prepared.reviewHash);
  // CLI approvals cannot bypass identity, version, reviewed bytes or explicit confirmation.
  await assert.rejects(()=>run(['approve',projectId,taskId,proposal.id,String(version),prepared.reviewHash!,'--confirm'],create.secret),/HTTP 403/);
  await assert.rejects(()=>run(['approve',projectId,taskId,proposal.id,String(version+1),prepared.reviewHash!,'--confirm'],reviewer.secret),/HTTP 409/);
  const key=randomUUID();
  const approval=await run(['approve',projectId,taskId,proposal.id,String(version),prepared.reviewHash!,'--confirm','--key',key],reviewer.secret);
  assert.equal(approval.commandKey,key);
  assert.equal(approval.result.decision,'approved');
  assert.equal(approval.result.task.task.status,'approved');
  assert.equal((await run(['task',projectId,taskId],reviewer.secret)).result.task.status,'approved');
  const rows=await pool.query('SELECT payload FROM task_outbox WHERE task_id=$1 ORDER BY id DESC LIMIT 1',[taskId]);
  assert.equal(rows.rows[0].payload.type,'task.status_changed');
  assert.equal(rows.rows[0].payload.actor.kind,'human');
  const ledger=await pool.query('SELECT action FROM git_integration_audit WHERE request_id=$1 AND action=$2',
   [proposal.id,'approved']);
  assert.equal(ledger.rowCount,1);
  const web=await api.inject({method:'GET',url:'/v1/projects/'+projectId+'/tasks',
   headers:{authorization:'Bearer '+reviewer.secret}});
  assert.equal(web.statusCode,200);
  assert.equal(web.json().tasks.find((item:{id:string})=>item.id===taskId).status,'approved');
 }finally{
  if(api)await api.close();
  await pool.end();
  rmSync(dir,{force:true,recursive:true,maxRetries:4,retryDelay:250});
 }
});
