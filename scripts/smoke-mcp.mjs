import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {PostgresOfficeRepository} from '../dist/packages/db/src/repository.js';
import {TokenStore} from '../dist/packages/db/src/tokens.js';

if(!process.env.DATABASE_URL){
 console.log('SKIP: S09 MCP smoke requires DATABASE_URL');
}else{
 const pool=createPool(process.env.DATABASE_URL),repo=new PostgresOfficeRepository(pool),tokens=new TokenStore(pool);
 const owner=randomUUID(),{project,office}=await repo.createProject({
  ownerId:owner,name:'S09 SDK MCP '+randomUUID(),repositoryRoot:null,template:'custom'
 });
 const credential=await tokens.provision({projectId:project.id,subjectId:owner,kind:'integration',
  scopes:['tasks:create','tasks:read','events:read'],origin:'desktop_commander',channel:'mcp',expiresInHours:1});
 const tcp=createServer();
 await new Promise((ok,fail)=>{tcp.once('error',fail);tcp.listen(0,'127.0.0.1',ok);});
 const port=tcp.address().port;await new Promise(ok=>tcp.close(ok));
 let apiProc;
 const apiUrl='http://127.0.0.1:'+port;
 const start=async()=>{
  apiProc=spawn(process.execPath,['dist/apps/api/src/main.js'],{
   cwd:process.cwd(),env:{...process.env,OMNYA_PORT:String(port),OMNYA_HOST:'127.0.0.1'},
   stdio:['ignore','ignore','pipe'],windowsHide:true
  });
  let diagnostic='';
  apiProc.stderr.on('data',x=>diagnostic+=String(x));
  for(let i=0;i<120;i++){
   if(apiProc.exitCode!==null)throw Error('Local API failed: '+diagnostic.slice(-300));
   try{const r=await fetch(apiUrl+'/v1/status');if(r.status===200)return;}catch{/* Startup pending. */}
   await delay(50);
  }
  throw Error('API not ready');
 };
 const stop=async()=>{
  if(!apiProc)return;
  const child=apiProc;apiProc=undefined;
  if(child.exitCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  if(!(await Promise.race([exited.then(()=>true),delay(5000).then(()=>false)])))throw Error('API did not terminate');
 };
 const client=new Client({name:'s09-stdio-smoke',version:'1.0.0'});
 const transport=new StdioClientTransport({
  command:process.execPath,args:['dist/apps/mcp/src/main.js'],
  env:{...Object.fromEntries(Object.entries(process.env).filter(entry=>typeof entry[1]==='string')),
   OMNYA_MCP_TOKEN:credential.secret,OMNYA_MCP_URL:apiUrl+'/'}
 });
 let connected=false;
 try{
  await start();
  await client.connect(transport);connected=true;
  const available=await client.listTools();
  assert.ok(available.tools.some(x=>x.name==='submit_task'));
  const key=randomUUID();
  const args={projectId:project.id,officeId:office.id,title:'MCP protocol task',
   description:'actual stdio adapter',idempotencyKey:key};
  const a=await client.callTool({name:'submit_task',arguments:args});
  assert.notEqual(a.isError,true,JSON.stringify(a).slice(0,200));
  const first=JSON.parse(a.content[0].text);
  assert.equal(first.replayed,false);assert.equal(first.origin,'desktop_commander');assert.equal(first.channel,'mcp');
  // A running MCP client continues to work against a fresh API process on the same loopback URL.
  await stop();
  await start();
  const b=await client.callTool({name:'submit_task',arguments:args});
  assert.notEqual(b.isError,true);
  const replay=JSON.parse(b.content[0].text);
  assert.equal(replay.replayed,true);
  assert.equal(first.task.id,replay.task.id);
  assert.equal(first.eventId,replay.eventId);
  assert.equal((await repo.listTasks(project.id)).length,1);
  assert.equal((await repo.listEvents(project.id)).length,1);
  const out=await fetch(apiUrl+'/v1/projects/'+project.id+'/outbox',{
   headers:{authorization:'Bearer '+credential.secret}});
  assert.equal(out.status,200);
  const messages=await out.json();assert.equal(messages.messages.length,1);
  assert.equal(messages.messages[0].event.source,'mcp');
  const mismatched=await client.callTool({name:'submit_task',arguments:{...args,title:'tampered'}});
  assert.equal(mismatched.isError,true);
  assert.equal((await repo.listTasks(project.id)).length,1);
  await tokens.revoke(credential.id);
  const denied=await client.callTool({name:'submit_task',arguments:{...args,idempotencyKey:randomUUID()}});
  assert.equal(denied.isError,true);
  console.log('PASS: real MCP stdio tool, authenticated HTTP ingress, token-bound provenance, idempotent replay, conflict, revoke (7/7)');
 }finally{
  if(connected)await client.close();
  await stop();
  await pool.end();
 }
}
