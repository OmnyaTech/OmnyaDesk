import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {EvidenceLedger,EvidenceNotFound} from '../packages/db/src/evidence-ledger.ts';
import type {Pool} from 'pg';

const enabled=!!process.env.DATABASE_URL;
let pool:Pool,repository:PostgresOfficeRepository,ledger:EvidenceLedger;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){
 const person=randomUUID();
 const p=await repository.createProject({ownerId:person,name:'S14 evidence '+randomUUID(),repositoryRoot:null,template:'custom'});
 const task=await repository.createTask({projectId:p.project.id,officeId:p.office.id,
  title:'Evidence '+randomUUID(),description:'',requestedBy:person});
 return {projectId:p.project.id,taskId:task.id,actorId:person};
}
before(async()=>{
 if(!enabled)return;
 pool=createPool(process.env.DATABASE_URL!);await runMigrations(pool);
 repository=new PostgresOfficeRepository(pool);ledger=new EvidenceLedger(pool);
});
after(async()=>{if(pool)await pool.end();});

test('S14 migration applied once, repeat does not modify schema',{skip:!enabled},async()=>{
 assert.deepEqual(await runMigrations(pool),[]);
 assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE name='011_evidence_audit.sql'")).rowCount,1);
});
test('S14 appends content-addressed log, diff, artifact; persisted SHA verifies after pool reconnection',{skip:!enabled},async()=>{
 const f=await fixture(),base={...f,scopeKey:'run:1',runId:null};
 const one=await ledger.append({...base,kind:'log',content:'first test output\n',metadata:{tool:'tests.run'}});
 const two=await ledger.append({...base,kind:'log',content:'second test output\n',metadata:{tool:'tests.run'}});
 const diff=await ledger.append({...base,kind:'diff',scopeKey:'changes:1',content:'diff --git a/README.md b/README.md\n'});
 const artifact=await ledger.append({...base,kind:'artifact',scopeKey:'report:1',content:'{"ok":true}\n'});
 assert.deepEqual([one.version,two.version,diff.version,artifact.version],[1,2,1,1]);
 assert.equal(one.contentSha256,sha('first test output\n'));
 assert.equal(two.previousChain,one.chainSha256);
 assert.equal((await ledger.verify(f.projectId,f.taskId,'log','run:1')).head,two.chainSha256);
 assert.equal((await ledger.read(f.projectId,f.taskId,artifact.id)).content,'{"ok":true}\n');
 await pool.end();
 pool=createPool(process.env.DATABASE_URL!);
 repository=new PostgresOfficeRepository(pool);ledger=new EvidenceLedger(pool);
 assert.equal((await ledger.verify(f.projectId,f.taskId,'log','run:1')).count,2);
 assert.equal((await ledger.read(f.projectId,f.taskId,diff.id)).contentSha256,sha(diff.content));
});
test('S14 append-only trigger rejects UPDATE and DELETE, even under direct SQL',{skip:!enabled},async()=>{
 const f=await fixture(),e=await ledger.append({...f,kind:'artifact',scopeKey:'snap:1',content:'untouched',metadata:{}});
 await assert.rejects(pool.query("UPDATE evidence_entries SET content=$1 WHERE id=$2",
  [Buffer.from('tamper'),e.id]),/append-only/);
 await assert.rejects(pool.query('DELETE FROM evidence_entries WHERE id=$1',[e.id]),/append-only/);
 await assert.rejects(pool.query('TRUNCATE evidence_entries CASCADE'),/append-only/);
 assert.equal((await ledger.read(f.projectId,f.taskId,e.id)).content,'untouched');
});
test('S14 SQL trigger rejects forged payload checksum, parent and version',{skip:!enabled},async()=>{
 const f=await fixture(),e=await ledger.append({...f,kind:'log',scopeKey:'events:1',content:'original'});
 const same=await ledger.list(f.projectId,f.taskId,'log','events:1');
 assert.equal(same.length,1);
 const query='INSERT INTO evidence_entries(id,project_id,task_id,kind,scope_key,version,actor_id,content,content_sha256,previous_chain,chain_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)';
 const params=[randomUUID(),f.projectId,f.taskId,'log','events:1',2,f.actorId,Buffer.from('injected'),
  sha('injected'),e.chainSha256,'a'.repeat(64)];
 await assert.rejects(pool.query(query,params),/chain digest mismatch/);
 await assert.rejects(pool.query(query,[...params.slice(0,5),3,...params.slice(6)]),/version\/previous chain mismatch/);
 await assert.rejects(pool.query(query,[...params.slice(0,8),'0'.repeat(64),...params.slice(9)]),/payload digest mismatch/);
 assert.equal((await ledger.verify(f.projectId,f.taskId,'log','events:1')).count,1);
});
test('S14 12 concurrent writers receive exactly versions 1..12, complete verified chain',{skip:!enabled},async()=>{
 const f=await fixture();
 const result=await Promise.all(Array.from({length:12},(_,i)=>ledger.append({
  ...f,kind:'log',scopeKey:'workers:concurrent',content:'line '+i
 })));
 assert.deepEqual(result.map(r=>r.version).sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i+1));
 const list=await ledger.list(f.projectId,f.taskId,'log','workers:concurrent');
 assert.equal(list.length,12);
 for(let i=1;i<list.length;i++)assert.equal(list[i]?.previousChain,list[i-1]?.chainSha256);
});
test('S14 cross-project/task read and invalid input are denied',{skip:!enabled},async()=>{
 const a=await fixture(),b=await fixture();
 const one=await ledger.append({...a,kind:'artifact',scopeKey:'a',content:'project A'});
 await assert.rejects(ledger.read(b.projectId,b.taskId,one.id),EvidenceNotFound);
 await assert.rejects(ledger.read(a.projectId,b.taskId,one.id),EvidenceNotFound);
 await assert.rejects(ledger.append({...a,kind:'artifact',scopeKey:'../escape',content:'bad'}));
 await assert.rejects(ledger.append({...a,kind:'artifact',scopeKey:'good',content:'X'.repeat(65537)}));
});
