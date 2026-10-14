import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {TokenStore} from '../packages/db/src/tokens.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';
// JS executable entry point and API are tested without shell/environment secrets.
// @ts-expect-error S28 CLI is an independent ESM package without emitted declarations.
import {executeCli} from '../apps/cli/src/client.mjs';
const uuid1=randomUUID(),uuid2=randomUUID(),secret='odt_'+'a'.repeat(64);
const mock=async (url:string,init:RequestInit)=>{
 const request=new URL(url);
 assert.equal(request.hostname,'127.0.0.1');
 assert.equal(init.redirect,'error');
 assert.equal((init.headers as Record<string,string>).Authorization,'Bearer '+secret);
 return {ok:true,status:200,json:async()=>({projects:[{id:uuid1,name:'Synthetic'}],tasks:[],events:[]})};
};
const cli=(args:string[],value?:Record<string,unknown>)=>executeCli(args,{token:secret,fetcher:mock,...value});
test('S28 CLI validates loopback, project UUID, required token and command grammar without network',async()=>{
 await assert.rejects(()=>cli(['tasks',uuid1],{baseUrl:'https://example.com'}),/OMNYA_URL/);
 await assert.rejects(()=>cli(['projects'],{baseUrl:'http://127.0.0.1:4317/admin'}),/OMNYA_URL/);
 await assert.rejects(()=>cli(['projects'],{baseUrl:'http://public.example:4317'}),/OMNYA_URL/);
 await assert.rejects(()=>cli(['projects'],{token:'bad'}),/OMNYA_TOKEN/);
 await assert.rejects(()=>cli(['tasks','../../another-project']),/UUID/);
 await assert.rejects(()=>cli(['create',uuid1,uuid2,'']),/Título/);
 await assert.rejects(()=>cli(['cancel',uuid1,uuid2,'1']),/--confirm/);
 await assert.rejects(()=>cli(['approve',uuid1,uuid2,uuid2,'1','a'.repeat(64)]),/--confirm/);
 await assert.rejects(()=>cli(['projects','extra']),/Argumentos/);
 await assert.rejects(()=>cli(['projects','--evil']),/Opção/);
 assert.match((await cli(['help'])).help,/atomic|ATÔMICA/);
});
test('S28 CLI sends canonical request shapes, idempotency key, no direct DB or arbitrary routes',async()=>{
 const out:{path:string;init:RequestInit}[]=[];
 const transport=async(url:string,init:RequestInit)=>{
  const parsed=new URL(url);out.push({path:parsed.pathname+parsed.search,init});
  return {ok:true,status:201,json:async()=>({task:{id:uuid2,status:'created'},events:[]})};
 };
 const opts={fetcher:transport,newUuid:()=>uuid1};
 const created=await cli(['create',uuid1,uuid2,'Tarefa real','Origem CLI'],opts);
 assert.equal(created.idempotencyKey,uuid1);
 assert.equal(out[0].path,'/v1/projects/'+uuid1+'/intake');
 assert.equal((out[0].init.headers as Record<string,string>)['Idempotency-Key'],uuid1);
 assert.deepEqual(JSON.parse(String(out[0].init.body)),{officeId:uuid2,title:'Tarefa real',description:'Origem CLI'});
 await cli(['cancel',uuid1,uuid2,'2','Solicitação','--confirm'],opts);
 assert.deepEqual(JSON.parse(String(out[1].init.body)),{
  commandKey:uuid1,expectedVersion:2,to:'cancelled',reason:'Solicitação'
 });
 await cli(['approve',uuid1,uuid2,uuid2,'4','b'.repeat(64),'--confirm'],opts);
 assert.equal(out[2].path,'/v1/projects/'+uuid1+'/tasks/'+uuid2+'/human-decisions');
 assert.deepEqual(JSON.parse(String(out[2].init.body)),{
  integrationId:uuid2,commandKey:uuid1,expectedVersion:4,
  reviewHash:'b'.repeat(64),decision:'approved',reason:null
 });
 await cli(['reject',uuid1,uuid2,uuid2,'4','b'.repeat(64),'Motivo','--confirm'],opts);
 assert.equal(JSON.parse(String(out[3].init.body)).decision,'rejected');
 await cli(['changes-requested',uuid1,uuid2,uuid2,'4','b'.repeat(64),'Revisar testes','--confirm'],opts);
 assert.equal(JSON.parse(String(out[4].init.body)).decision,'changes_requested');
});
test('S28 CLI shields token and raw server messages on HTTP error or failure',async()=>{
 const transport=async()=>({ok:false,status:403,json:async()=>({error:'odt_'+'a'.repeat(64)})});
 await assert.rejects(()=>cli(['projects'],{fetcher:transport}),(err:Error)=>{
  assert.ok(!err.message.includes(secret));assert.match(err.message,/403/);return true;
 });
 await assert.rejects(()=>cli(['projects'],{fetcher:async()=>{throw Error(secret)}}),(err:Error)=>{
  assert.ok(!err.message.includes(secret));return true;
 });
});
test('S28 exposes retry idempotency key before uncertain network response, never token',async()=>{
 const key=randomUUID(),seen:{label:string;value:string}[]=[];
 await assert.rejects(()=>cli(['create',uuid1,uuid2,'Retry safe'],{
  newUuid:()=>key,
  onMutationKey:(label:string,value:string)=>{seen.push({label,value});},
  fetcher:async()=>{assert.deepEqual(seen,[{label:'Idempotency-Key',value:key}]);throw Error(secret);}
 }),/API local indisponível/);
 assert.ok(!JSON.stringify(seen).includes(secret));
});
const db=process.env.DATABASE_URL;
let pool:Pool,repo:PostgresOfficeRepository,tokens:TokenStore,api:FastifyInstance;
const actor=randomUUID();
let projectId:string,officeId:string,otherId:string,tokenRead:string,tokenWrite:string,tokenForeign:string;
before(async()=>{
 if(!db)return;
 pool=createPool(db);await runMigrations(pool);repo=new PostgresOfficeRepository(pool);tokens=new TokenStore(pool);
 const p=await repo.createProject({ownerId:actor,name:'S28 CLI '+randomUUID(),repositoryRoot:null,template:'startup'});
 const foreign=await repo.createProject({ownerId:actor,name:'S28 foreign '+randomUUID(),repositoryRoot:null,template:'startup'});
 projectId=p.project.id;officeId=p.office.id;otherId=foreign.project.id;
 tokenRead=(await tokens.provision({projectId,subjectId:actor,kind:'human',
  scopes:['projects:read','tasks:read','events:read'],expiresInHours:1})).secret;
 tokenWrite=(await tokens.provision({projectId,subjectId:actor,kind:'human',
  scopes:['projects:read','tasks:read','tasks:create','tasks:transition','events:read','git:review'],expiresInHours:1})).secret;
 tokenForeign=(await tokens.provision({projectId:otherId,subjectId:actor,kind:'human',
  scopes:['projects:read','tasks:read','tasks:create','events:read'],expiresInHours:1})).secret;
 api=await buildPersistentApi(pool);
});
after(async()=>{if(api)await api.close();if(pool)await pool.end();});
function gateway(token:string){
 return async(url:string,init:RequestInit)=>{
  const u=new URL(url);
  assert.equal(u.hostname,'127.0.0.1');
  assert.equal(init.redirect,'error');
  const res=await api.inject({method:init.method as 'GET'|'POST',url:u.pathname+u.search,
   headers:{...(init.headers as Record<string,string>),Authorization:'Bearer '+token},
   payload:init.body as string|undefined});
  return {status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,json:async()=>res.json()};
 };
}
function run(args:string[],token=tokenWrite){
 return executeCli(args,{token,fetcher:gateway(token)});
}
test('S28 CLI creates/list/tasks/logs/evidence same persisted state as web API; retries idempotent',{skip:!db},async()=>{
 const projects=await run(['projects']);
 assert.deepEqual(projects.result.projects.map((p:{id:string})=>p.id),[projectId]);
 const idem=randomUUID();
 const args=['create',projectId,officeId,'Registro via CLI','Web deve ver', '--key',idem];
 const first=await run(args);
 assert.equal(first.result.replayed,false);
 const duplicate=await run(args);
 assert.equal(duplicate.result.replayed,true);
 const taskId=first.result.task.id;
 assert.equal(duplicate.result.task.id,taskId);
 const list=await run(['tasks',projectId]);
 assert.equal(list.result.tasks.filter((t:{id:string})=>t.id===taskId).length,1);
 const task=await run(['task',projectId,taskId]);
 assert.equal(task.result.task.description,'Web deve ver');
 const web=await api.inject({method:'GET',url:'/v1/projects/'+projectId+'/tasks',
  headers:{authorization:'Bearer '+tokenRead}});
 assert.equal(web.statusCode,200);
 assert.equal(web.json().tasks.find((t:{id:string})=>t.id===taskId).version,1);
 const logs=await run(['logs',projectId,'--task',taskId]);
 assert.equal(logs.result.events.length,1);
 assert.equal(logs.result.events[0].taskId,taskId);
 const cursor=logs.result.events[0].sequence;
 const after=await run(['logs',projectId,'--after',String(cursor)]);
 assert.equal(after.result.events.length,0);
 const evidence=await run(['evidence',projectId,taskId]);
 assert.deepEqual(evidence.result.evidence,[]);
 const cancelled=await run(['cancel',projectId,taskId,'1','Cancelamento de operador','--confirm','--key',randomUUID()]);
 assert.equal(cancelled.result.task.status,'cancelled');
 assert.equal((await run(['task',projectId,taskId])).result.task.status,'cancelled');
 const seen=await run(['logs',projectId,'--task',taskId]);
 assert.equal(seen.result.events.some((e:{type:string})=>e.type==='task.status_changed'),true);
});
test('S28 CLI cannot mutate with read-only token or cross-project token',{skip:!db},async()=>{
 await assert.rejects(()=>run(['create',projectId,officeId,'Negado'],tokenRead),/HTTP 403/);
 await assert.rejects(()=>run(['tasks',projectId],tokenForeign),/HTTP 404/);
 await assert.rejects(()=>run(['create',projectId,officeId,'Negado'],tokenForeign),/HTTP 404/);
});
test('S28 CLI review listing uses canonical human approval API with real scopes',{skip:!db},async()=>{
 const listing=await run(['reviews',projectId]);
 assert.ok(Array.isArray(listing.result.integrations));
 await assert.rejects(()=>run(['reviews',projectId],tokenForeign),/HTTP 404/);
 await assert.rejects(()=>run(['approve',projectId,randomUUID(),randomUUID(),'1','a'.repeat(64),'--confirm']),/HTTP 409/);
});
