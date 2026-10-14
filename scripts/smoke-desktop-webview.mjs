import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';

const folder=join(process.cwd(),'dist/apps/desktop');
const projects=[
 {id:'11111111-1111-4111-8111-111111111111',name:'Projeto A'},
 {id:'22222222-2222-4222-8222-222222222222',name:'Projeto B'}
];
const taskIds=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const now=new Date().toISOString();
const server=createServer(async(req,res)=>{
 const name=new URL(req.url??'/', 'http://127.0.0.1').pathname.slice(1)||'index.html';
 if(!['index.html','app.js','app.css'].includes(name)){res.writeHead(404).end();return;}
 res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
 res.end(await readFile(join(folder,name)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const browserPath=process.env.OMNYA_S20_BROWSER||
 (process.platform==='win32'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':'/usr/bin/chromium');
let browser;
try{
 browser=await chromium.launch({executablePath:browserPath,headless:true});
 const page=await browser.newPage({viewport:{width:1360,height:900},serviceWorkers:'block'});
 await page.addInitScript(({projects,taskIds,now})=>{
  let enrolled=false,registered=[],active=null,offline=false,phase='planning';
  const histories=projects.map((p,i)=>[
   {schemaVersion:1,sequence:1,eventId:p.id,projectId:p.id,taskId:taskIds[i],type:'task.created',occurredAt:now,actor:{kind:'system'}},
   {schemaVersion:1,sequence:2,eventId:p.id,projectId:p.id,taskId:taskIds[i],type:'task.status_changed',occurredAt:now,
    actor:{kind:'system'},payload:{from:'created',to:i===0?'planning':'awaiting_approval'}}
  ]);
  const task=(i)=>({id:taskIds[i],projectId:projects[i].id,officeId:projects[i].id,
   title:i===0?'Projeto A tarefa real':'Projeto B revisão humana',status:i===0?phase:'awaiting_approval',
   version:2,currentRunId:null,updatedAt:now,createdAt:now});
  let calls=[];
  window.__testDesktop={
   setOffline:v=>{offline=v;},calls:()=>calls.slice(),
   transition:()=>{phase='implementing';histories[0].push({schemaVersion:1,sequence:3,
    eventId:projects[0].id,projectId:projects[0].id,taskId:taskIds[0],type:'task.status_changed',
    occurredAt:now,actor:{kind:'system'},payload:{from:'planning',to:'implementing'}});}
  };
  window.__TAURI__={core:{invoke:async(command,args={})=>{
   calls.push(command);
   if(command==='desktop_restore'){if(!enrolled)throw Error('Not enrolled');return {projects:registered};}
   if(command==='desktop_login'){
    if(args.value==='ods_'+'b'.repeat(64))throw 'Workstation session is invalid or expired';
    if(!/^ods_[a-f0-9]{64}$/.test(args.value))throw Error('Invalid key');
    enrolled=true;return {projects:registered};
   }
   if(command==='desktop_register'){
    if(!enrolled)throw Error('Unauthorized');
    const next=projects[registered.length];
    if(!next)throw Error('No more test projects');
    registered.push(next);return {project:next};
   }
   if(command==='desktop_select'){
    if(!registered.some(p=>p.id===args.projectId))throw Error('Project ACL violation');
    active=args.projectId;return {projectId:active};
   }
   if(command==='desktop_logout'){active=null;enrolled=false;return null;}
   if(command==='desktop_poll'){
    if(offline)throw Error('API offline');
    const i=projects.findIndex(p=>p.id===active);
    if(i<0)throw Error('No authorized project');
    return {events:histories[i].filter(e=>e.sequence>args.after)};
   }
   if(command==='desktop_read'){
    const i=projects.findIndex(p=>p.id===active),prefix='/v1/projects/'+active;
    if(i<0||!args.path.startsWith(prefix))throw Error('Native scope denied');
    if(args.path.endsWith('/tasks'))return {tasks:[task(i)]};
    if(args.path.includes('/events?after='))return {events:histories[i].filter(e=>e.sequence>Number(args.path.split('after=')[1]))};
    if(args.path.endsWith('/evidence'))return {evidence:[]};
    throw Error('Native path denied');
   }
   throw Error('Unrecognized command: '+command);
  }}};
 },{projects,taskIds,now});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const outbound=[];
 page.on('request',req=>{if(req.url().includes('/v1/'))outbound.push(req.url());});
 await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load'});
 await page.getByRole('heading',{name:'Conecte seu projeto'}).waitFor();
 await page.getByLabel('Chave de inscrição da estação').fill('ods_'+'b'.repeat(64));
 await page.getByRole('button',{name:'Conectar com segurança'}).click();
 await page.getByRole('alert').getByText('A inscrição da estação foi recusada ou expirou. Use uma nova chave de inscrição válida.').waitFor();
 await page.getByRole('button',{name:'Conectar com segurança'}).waitFor({state:'visible'});
 await page.getByLabel('Chave de inscrição da estação').fill('ods_'+'a'.repeat(64));
 await page.getByRole('button',{name:'Conectar com segurança'}).click();
 await page.getByRole('heading',{name:'Cadastre seu primeiro projeto'}).waitFor();
 await page.getByRole('button',{name:'Escolher pasta do projeto'}).click();
 await page.getByRole('heading',{name:'Projeto A'}).waitFor();
 await page.getByRole('status').getByText('Sincronização ativa').waitFor({timeout:10000});
 await page.getByText('Projeto A tarefa real').first().waitFor();
 assert.equal(await page.getByRole('region',{name:'Alertas de intervenção'}).count(),0);
 await page.getByRole('button',{name:'Adicionar pasta…'}).click();
 await page.getByLabel('Projeto local').selectOption(projects[1].id);
 await page.getByRole('heading',{name:'Projeto B'}).waitFor();
 await page.getByRole('region',{name:'Alertas de intervenção'}).getByText('Projeto B revisão humana').waitFor();
 await page.getByRole('button',{name:'Ver eventos e evidências'}).click();
 await page.getByText('task.created').waitFor();
 await page.getByLabel('Projeto local').selectOption(projects[0].id);
 await page.getByRole('heading',{name:'Projeto A'}).waitFor();
 await page.evaluate(()=>window.__testDesktop.setOffline(true));
 await page.getByText('Sem conexão ativa').waitFor({timeout:12000});
 await page.evaluate(()=>{window.__testDesktop.transition();window.__testDesktop.setOffline(false);});
 await page.getByRole('status').getByText('Sincronização ativa').waitFor({timeout:12000});
 await page.getByRole('listitem').filter({hasText:'Desenvolvedor'}).getByText('Em execução — 1 tarefa(s)').waitFor();
 assert.deepEqual(outbound,[],'No direct browser API traffic or bearer exposure');
 const storage=await page.evaluate(()=>({ls:Object.keys(localStorage),ss:Object.keys(sessionStorage)}));
 assert.deepEqual(storage,{ls:[],ss:[]});
 assert.deepEqual(errors,[],'Desktop WebView React runtime exception');
 await page.screenshot({path:join(folder,'s24-native-bridge-synthetic.png'),fullPage:true});
 await page.getByRole('button',{name:'Sair'}).click();
 await page.getByRole('heading',{name:'Conecte seu projeto'}).waitFor();
 console.log('PASS: S24 simulated Tauri WebView enrollment, native folder registry, 2-project ACL switching, offline pause/replay, no browser secrets or direct network (12/12)');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
