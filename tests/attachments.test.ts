import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {before,after,test} from 'node:test';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {WorkstationRegistry} from '../packages/db/src/workstation.ts';
import {inspectUpload,MAX_ATTACHMENT_BYTES} from '../packages/db/src/attachments.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const goodDiff=Buffer.from('diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+safe\n','utf8');
const goodPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlBLeUAAAAASUVORK5CYII=','base64');
const input=(name='review.diff',bytes=goodDiff,mime='text/x-diff')=>({filename:name,mimeType:mime,dataBase64:bytes.toString('base64')});
const db=process.env.DATABASE_URL;
let pool:Pool,api:FastifyInstance,repo:PostgresOfficeRepository,store:TokenStore;
let projectId='',taskId='',otherId='',tokenRead='',tokenWrite='',tokenWrong='',session='',otherSession='';
const target=()=>'/v1/projects/'+projectId+'/tasks/'+taskId+'/attachments';
const upload=async(secret:string,body:unknown=input(),url=target(),headers:Record<string,string>={})=>
 api.inject({method:'POST',url,headers:{host:'127.0.0.1:4317','content-type':'application/json',authorization:'Bearer '+secret,...headers},payload:JSON.stringify(body)});
const get=async(secret:string,url=target(),headers:Record<string,string>={})=>
 api.inject({method:'GET',url,headers:{host:'127.0.0.1:4317',authorization:'Bearer '+secret,...headers}});
before(async()=>{
 if(!db)return;
 pool=createPool(db);await runMigrations(pool);
 repo=new PostgresOfficeRepository(pool);store=new TokenStore(pool);
 const subject=randomUUID();
 const a=await repo.createProject({ownerId:subject,name:'S27 private A '+randomUUID(),repositoryRoot:null,template:'startup'});
 const b=await repo.createProject({ownerId:subject,name:'S27 private B '+randomUUID(),repositoryRoot:null,template:'startup'});
 projectId=a.project.id;otherId=b.project.id;
 const task=await repo.createTask({projectId,officeId:a.office.id,requestedBy:subject,title:'S27 photo and patch',description:''});
 taskId=task.id;
 tokenRead=(await store.provision({projectId,subjectId:subject,kind:'human',
  scopes:['tasks:read'],expiresInHours:1})).secret;
 tokenWrite=(await store.provision({projectId,subjectId:subject,kind:'human',
  scopes:['files:write','tasks:read'],expiresInHours:1})).secret;
 tokenWrong=(await store.provision({projectId:otherId,subjectId:subject,kind:'human',
  scopes:['files:write','tasks:read'],expiresInHours:1})).secret;
 const registry=new WorkstationRegistry(pool);
 const station=await registry.issue(subject);
 const other=await registry.issue(randomUUID());
 session=station.secret;otherSession=other.secret;
 await pool.query('INSERT INTO workstation_projects (workstation_id,project_id,canonical_root) VALUES($1,$2,$3)',
  [station.id,projectId,'C:\\S27-qa-only-'+randomUUID()]);
 api=await buildPersistentApi(pool);
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});

test('S27 MIME validation checks magic bytes, safe names, active content and size',()=>{
 const png=inspectUpload(input('small.png',goodPng,'image/png'));
 assert.equal(png.mimeType,'image/png');
 assert.equal(png.sha256,createHash('sha256').update(goodPng).digest('hex'));
 assert.equal(inspectUpload(input()).mimeType,'text/x-diff');
 for(const sample of [
  input('../escape.diff'),input('bad.exe'),input('evil.jpg',Buffer.from('MZ\x01\x02'),'image/jpeg'),
  input('bad.png',goodDiff,'image/png'),input('unicode.diff',Buffer.from([0xff,0xfe])),
  input('bad.diff',Buffer.from('not an actual patch')),input('bad.pdf',Buffer.from('%PDF-1.4\n/JavaScript\n%%EOF'),'application/pdf'),
  input('bad.zip',Buffer.from('PK\x03\x04'),'text/x-diff'),
  input('fake.pdf',Buffer.from('%PDF-1.4\n/Launch\n%%EOF'),'application/pdf'),
  input('oversized.txt',Buffer.alloc(MAX_ATTACHMENT_BYTES+1,65),'text/plain'),
  {...input(),dataBase64:'@@@@'}
 ])assert.throws(()=>inspectUpload(sample),'File must be refused: '+sample.filename);
});

test('S27 auth: read token cannot upload, missing token 401, cross project 404',{skip:!db},async()=>{
 assert.equal((await upload(tokenRead)).statusCode,403);
 assert.equal((await upload('odt_'+'a'.repeat(64))).statusCode,401);
 assert.equal((await upload(tokenWrong)).statusCode,404);
 assert.equal((await get(tokenWrong)).statusCode,404);
 assert.equal((await get(tokenRead)).statusCode,200);
});

test('S27 immutable validated upload, scoped list and exact SHA256 after retrieval',{skip:!db},async()=>{
 const uploadResult=await upload(tokenWrite);
 assert.equal(uploadResult.statusCode,201,uploadResult.body);
 const meta=uploadResult.json().attachment;
 assert.equal(meta.filename,'review.diff');assert.equal(meta.mimeType,'text/x-diff');
 assert.equal(meta.sha256,createHash('sha256').update(goodDiff).digest('hex'));
 const files=await get(tokenRead);
 assert.equal(files.statusCode,200);
 assert.ok(files.json().attachments.some((file:{id:string})=>file.id===meta.id));
 assert.ok(!files.body.includes(goodDiff.toString('base64')),'list never exposes raw bytes');
 const retrieved=await get(tokenRead,target()+'/'+meta.id);
 assert.equal(retrieved.statusCode,200);
 assert.equal(retrieved.json().dataBase64,goodDiff.toString('base64'));
 assert.equal(retrieved.headers['cache-control'],'private,no-store');
 assert.equal((await get(tokenWrong,target()+'/'+meta.id)).statusCode,404);
 assert.equal((await get(tokenRead,target()+'/'+randomUUID())).statusCode,404);
 assert.equal((await pool.query('SELECT data FROM task_attachments WHERE id=$1',[meta.id])).rows[0].data.toString('hex'),goodDiff.toString('hex'));
 await assert.rejects(pool.query('UPDATE task_attachments SET filename=$2 WHERE id=$1',[meta.id,'tampered.txt']));
});

test('S27 rejects spoofed payload, path traversal, unsafe MIME and missing task',{skip:!db},async()=>{
 for(const candidate of [input('evil.exe'),input('../../evil.diff'),
  input('evil.png',goodDiff,'image/png'),{...input(),extra:'unsafe'}]){
  const r=await upload(tokenWrite,candidate);
  assert.equal(r.statusCode,400,r.body);
 }
 assert.equal((await upload(tokenWrite,input(),'/v1/projects/'+projectId+'/tasks/'+randomUUID()+'/attachments')).statusCode,404);
 const tooLarge=await upload(tokenWrite,input('large.txt',Buffer.alloc(MAX_ATTACHMENT_BYTES+1,65),'text/plain'));
 assert.equal(tooLarge.statusCode,413);
});

test('S27 native workstation POST is bound to selected authorized project, never browser-origin',{skip:!db},async()=>{
 const path='/v1/workstation/projects/'+projectId+'/tasks/'+taskId+'/attachments';
 assert.equal((await upload(otherSession,input(),path)).statusCode,404);
 assert.equal((await upload(session,input(),path,{origin:'http://malicious.test'})).statusCode,403);
 assert.equal((await upload(session,input(),path,{'sec-fetch-site':'cross-site'})).statusCode,403);
 assert.equal((await upload(tokenRead,input(),path)).statusCode,401);
 const saved=await upload(session,input('notes.txt',Buffer.from('Private read-only record'),'text/plain'),path);
 assert.equal(saved.statusCode,201,saved.body);
 assert.equal((await get(tokenRead,target()+'/'+saved.json().attachment.id)).statusCode,200);
});
test('S27 concurrency enforces 20-attachment limit without races',{skip:!db},async()=>{
 const attempts=await Promise.all(Array.from({length:21},(_,i)=>upload(tokenWrite,input('patch'+i+'.diff'))));
 const accepted=attempts.filter(x=>x.statusCode===201),limited=attempts.filter(x=>x.statusCode===413);
 // The previous tests uploaded one patch and one text document.
 assert.equal(accepted.length,18,attempts.map(x=>x.statusCode).join(','));
 assert.equal(limited.length,3);
 const list=await get(tokenRead);
 assert.equal(list.json().attachments.length,20);
 assert.ok(list.json().attachments.every((x:{sha256:string})=>/^[a-f0-9]{64}$/.test(x.sha256)));
});
test('S27 OpenAPI declares scoped attachment endpoints and native route is hidden',{skip:!db},async()=>{
 const doc=(await api.inject({method:'GET',url:'/openapi.json'})).json();
 const route='/v1/projects/{projectId}/tasks/{taskId}/attachments';
 assert.ok(doc.paths[route]);assert.deepEqual(doc.paths[route].post.security,[{bearerToken:[]}]);
 assert.ok(!doc.paths['/v1/workstation/projects/{projectId}/tasks/{taskId}/attachments']);
});
