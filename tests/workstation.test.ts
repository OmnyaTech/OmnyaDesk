import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,before,test} from 'node:test';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {verifiedFolder,WorkstationRegistry} from '../packages/db/src/workstation.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

const db=process.env.DATABASE_URL;
let root='',inside='',outside='',pool:Pool,api:FastifyInstance,session='',other='',projectId='';
const auth=(credential:string,extra:Record<string,string>={})=>({
 host:'127.0.0.1:4317',authorization:'Bearer '+credential,...extra
});
const call=async(method:'GET'|'POST',url:string,credential:string,payload?:Record<string,unknown>,
 headers:Record<string,string>={})=>await api.inject({method,url,headers:auth(credential,headers),payload});
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'omnya-s24-roots-'));
 inside=join(root,'allowed');outside=join(root,'forbidden');
 await mkdir(inside);await mkdir(outside);
 await mkdir(join(inside,'alpha'));await mkdir(join(inside,'beta'));
 if(!db)return;
 pool=createPool(db);await runMigrations(pool);
 const registry=new WorkstationRegistry(pool);
 session=(await registry.issue(randomUUID())).secret;
 other=(await registry.issue(randomUUID())).secret;
 api=await buildPersistentApi(pool);
 process.env.OMNYA_WORKSTATION_ALLOWED_ROOTS=inside;
});
after(async()=>{delete process.env.OMNYA_WORKSTATION_ALLOWED_ROOTS;
 if(api)await api.close();if(pool)await pool.end();
 if(root)await rm(root,{recursive:true,force:true});
});
test('S24 folders enforce root, junction and traversal checks',async()=>{
 assert.equal(await verifiedFolder(join(inside,'alpha'),inside),join(inside,'alpha'));
 await assert.rejects(verifiedFolder(outside,inside));
 await assert.rejects(verifiedFolder('relative-folder',inside));
 await assert.rejects(verifiedFolder(join(inside,'missing'),inside));
 try {
  await symlink(outside,join(inside,'junction'),'junction');
  await assert.rejects(verifiedFolder(join(inside,'junction'),inside));
 }catch(e){if((e as NodeJS.ErrnoException).code!=='EPERM')throw e;}
});
test('S24 rejects unauthenticated, browser-origin and cross-origin localhost callers',{skip:!db},async()=>{
 const path='/v1/workstation/projects';
 assert.equal((await call('GET',path,'odt_'+'a'.repeat(64))).statusCode,401);
 assert.equal((await call('GET',path,session,undefined,{origin:'http://evil.test'})).statusCode,403);
 assert.equal((await call('GET',path,session,undefined,{'sec-fetch-site':'cross-site'})).statusCode,403);
 assert.equal((await call('GET',path,session,undefined,{referer:'http://localhost:4317/'})).statusCode,403);
 assert.equal((await call('GET',path,session,undefined,{host:'evil.test'})).statusCode,403);
 assert.equal((await call('GET',path,session)).statusCode,200);
});
test('S24 workstation registers only authorized local folders and isolates projects',{skip:!db},async()=>{
 const base='/v1/workstation/projects';
 const forbidden=await call('POST',base,session,{path:outside,name:'Forbidden'});
 assert.equal(forbidden.statusCode,403);
 const reg=await call('POST',base,session,{path:join(inside,'alpha'),name:'Alpha'});
 assert.equal(reg.statusCode,201,reg.body);projectId=reg.json().project.id;
 const duplicate=await call('POST',base,session,{path:join(inside,'alpha'),name:'Duplicate'});
 assert.equal(duplicate.statusCode,403);
 const collision=await call('POST',base,other,{path:join(inside,'alpha'),name:'Same physical root'});
 assert.equal(collision.statusCode,403,'A second workstation cannot evade the S10 physical root lock');
 const listing=await call('GET',base,session);
 assert.equal(listing.json().projects.length,1);
 const otherList=await call('GET',base,other);
 assert.deepEqual(otherList.json().projects,[]);
 const denied=await call('POST',base+'/'+projectId+'/access',other);
 assert.equal(denied.statusCode,404);
 const allowed=await call('POST',base+'/'+projectId+'/access',session);
 assert.equal(allowed.statusCode,200,allowed.body);
 const credential=allowed.json().token;
 assert.match(credential,/^odt_[a-f0-9]{64}$/);
 const principal=await new TokenStore(pool).authenticate('Bearer '+credential);
 assert.deepEqual(principal?.scopes.slice().sort(),['events:read','projects:read','tasks:read']);
 assert.equal((await call('GET','/v1/projects/'+projectId+'/tasks',credential)).statusCode,200);
 assert.equal((await call('POST','/v1/projects/'+projectId+'/transitions',credential,{})).statusCode!==200,true);
 const malformed=await call('POST',base,session,{path:join(inside,'beta'),name:'Beta',admin:true});
 assert.equal(malformed.statusCode,400);
});
