import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {join} from 'node:path';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';
type RunResult={exit:number|null;stdout:string;stderr:string};
function runCommand(args:string[],base:string,token?:string):Promise<RunResult>{
 return new Promise((resolve,reject)=>{
  const cli=join(process.cwd(),'apps','cli','src','main.mjs');
  const child=spawn(process.execPath,[cli,...args],{windowsHide:true,
   env:{...process.env,OMNYA_URL:base,OMNYA_TOKEN:token??''},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',(chunk:Buffer)=>{stdout+=String(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{stderr+=String(chunk);});
  const timer=setTimeout(()=>{child.kill();reject(Error('CLI process timed out'));},10000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);resolve({exit:code,stdout,stderr});});
 });
}
test('S28 actual pnpm CLI executable and Web API share persisted PostgreSQL state over localhost HTTP',{skip:!process.env.DATABASE_URL},async()=>{
 const pool=createPool(process.env.DATABASE_URL!);
 let api:Awaited<ReturnType<typeof buildPersistentApi>>|undefined;
 try{
  await runMigrations(pool);
  const repo=new PostgresOfficeRepository(pool),store=new TokenStore(pool);
  const id=randomUUID();
  const {project,office}=await repo.createProject({ownerId:id,name:'S28 CLI real process '+randomUUID(),repositoryRoot:null,template:'startup'});
  const auth=async(scopes:('projects:read'|'tasks:read'|'tasks:create'|'tasks:transition'|'events:read')[])=>
   (await store.provision({projectId:project.id,subjectId:id,kind:'human',scopes,expiresInHours:1,origin:'cli'})).secret;
  const token=await auth(['projects:read','tasks:read','tasks:create','tasks:transition','events:read']);
  const readonly=await auth(['projects:read','tasks:read','events:read']);
  api=await buildPersistentApi(pool);
  const base=await api.listen({port:0,host:'127.0.0.1'});
  const call=(args:string[],value=token)=>runCommand(args,base,value);
  const listed=await call(['projects']);
  assert.equal(listed.exit,0,listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).projects.map((p:{id:string})=>p.id),[project.id]);
  const key=randomUUID();
  const created=await call(['create',project.id,office.id,'Criado pela CLI','Sincronização API','--key',key]);
  assert.equal(created.exit,0,created.stderr);
  assert.ok(created.stderr.includes(key));
  assert.ok(!created.stderr.includes(token));
  const task=JSON.parse(created.stdout).task;
  const replay=await call(['create',project.id,office.id,'Criado pela CLI','Sincronização API','--key',key]);
  assert.equal(replay.exit,0,replay.stderr);
  assert.equal(JSON.parse(replay.stdout).task.id,task.id);
  assert.equal(JSON.parse(replay.stdout).replayed,true);
  const fromWeb=await api.inject({method:'GET',url:'/v1/projects/'+project.id+'/tasks',
   headers:{authorization:'Bearer '+readonly}});
  assert.equal(fromWeb.statusCode,200);
  assert.equal(fromWeb.json().tasks.filter((t:{id:string})=>t.id===task.id).length,1);
  const denied=await call(['cancel',project.id,task.id,'1','Cancelado','--confirm'],readonly);
  assert.equal(denied.exit,1);
  assert.match(denied.stderr,/403/);assert.ok(!denied.stderr.includes(readonly));
  const stopKey=randomUUID();
  const stop=await call(['cancel',project.id,task.id,'1','Cancelado','--confirm','--key',stopKey]);
  assert.equal(stop.exit,0,stop.stderr);
  assert.equal(JSON.parse(stop.stdout).task.status,'cancelled');
  const after=await call(['logs',project.id,'--task',task.id]);
  assert.equal(after.exit,0,after.stderr);
  assert.equal(JSON.parse(after.stdout).events.length,2);
  const listedAgain=await api.inject({method:'GET',url:'/v1/projects/'+project.id+'/tasks',
   headers:{authorization:'Bearer '+readonly}});
  assert.equal(listedAgain.json().tasks.find((t:{id:string})=>t.id===task.id).status,'cancelled');
  const noToken=await runCommand(['tasks',project.id],base);
  assert.equal(noToken.exit,2);
  assert.match(noToken.stderr,/OMNYA_TOKEN/);
 }finally{
  if(api)await api.close();
  await pool.end();
 }
});
