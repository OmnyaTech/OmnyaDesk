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
  let prefs={mode:'full',alwaysOnTop:false},minimized=false;
  const histories=projects.map((p,i)=>[
   {schemaVersion:1,sequence:1,eventId:p.id,projectId:p.id,taskId:taskIds[i],type:'task.created',occurredAt:now,actor:{kind:'system'}},
   {schemaVersion:1,sequence:2,eventId:p.id,projectId:p.id,taskId:taskIds[i],type:'task.status_changed',occurredAt:now,
    actor:{kind:'system'},payload:{from:'created',to:i===0?'planning':'awaiting_approval'}}
  ]);
  const task=(i)=>({id:taskIds[i],projectId:projects[i].id,officeId:projects[i].id,
   title:i===0?'Projeto A tarefa real':'Projeto B revisão humana',status:i===0?phase:'awaiting_approval',
   version:2,currentRunId:null,updatedAt:now,createdAt:now});
  let calls=[];
  const stored=[];
  window.__testDesktop={
   setOffline:v=>{offline=v;},calls:()=>calls.slice(),
   windowState:()=>({prefs,minimized}),
   transition:()=>{phase='implementing';histories[0].push({schemaVersion:1,sequence:3,
    eventId:projects[0].id,projectId:projects[0].id,taskId:taskIds[0],type:'task.status_changed',
    occurredAt:now,actor:{kind:'system'},payload:{from:'planning',to:'implementing'}});}
  };
  window.__TAURI__={core:{invoke:async(command,args={})=>{
   calls.push(command);
   if(command==='desktop_window_state')return prefs;
   if(command==='desktop_window_mode'){
    if(!['full','compact','floating','taskbar'].includes(args.mode))throw 'Unknown mode';
    prefs={...prefs,mode:args.mode};return prefs;
   }
   if(command==='desktop_always_on_top'){prefs={...prefs,alwaysOnTop:!!args.enabled};return prefs;}
   if(command==='desktop_minimize_to_tray'){minimized=true;return null;}
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
   if(command==='desktop_upload'){
    if(!enrolled||args.projectId!==active||!taskIds.includes(args.taskId))throw Error('S27 native project ACL denied');
    const id='cccccccc-cccc-4ccc-8ccc-'+String(stored.length+1).padStart(12,'0');
    const attachment={id,taskId:args.taskId,filename:args.filename,mimeType:args.mimeType,
      sizeBytes:atob(args.dataBase64).length,sha256:'a'.repeat(64),createdAt:now};
    stored.push({attachment,dataBase64:args.dataBase64,projectId:active});
    return {attachment};
   }
   if(command==='desktop_read'){
    const i=projects.findIndex(p=>p.id===active),prefix='/v1/projects/'+active;
    if(i<0||!args.path.startsWith(prefix))throw Error('Native scope denied');
    if(args.path.endsWith('/tasks'))return {tasks:[task(i)]};
    if(args.path.includes('/events?after='))return {events:histories[i].filter(e=>e.sequence>Number(args.path.split('after=')[1]))};
    if(args.path.endsWith('/evidence'))return {evidence:[]};
    if(args.path.endsWith('/attachments'))return {attachments:stored.filter(s=>s.projectId===active&&s.attachment.taskId===taskIds[i]).map(s=>s.attachment)};
    if(args.path.includes('/attachments/')){
     const id=args.path.split('/attachments/')[1];const match=stored.find(s=>s.projectId===active&&s.attachment.taskId===taskIds[i]&&s.attachment.id===id);
     if(!match)throw Error('Not found');return {attachment:match.attachment,dataBase64:match.dataBase64};
    }
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
 // S25: modes, tray, native always-on-top command and compact responsive UI.
 await page.getByRole('button',{name:'Flutuante'}).click();
 await page.locator('html[data-office-mode="floating"]').waitFor();
 await page.getByRole('button',{name:'Taskbar'}).click();
 await page.locator('html[data-office-mode="taskbar"]').waitFor();
 assert.notEqual(await page.locator('.rail').evaluate(el=>getComputedStyle(el).display),'none','Enrollment must remain accessible before login');
 await page.getByRole('button',{name:'Sempre no topo'}).click();
 assert.equal(await page.evaluate(()=>window.__testDesktop.windowState().prefs.alwaysOnTop),true);
 await page.getByRole('button',{name:'Completo'}).click();
 await page.locator('html[data-office-mode="full"]').waitFor();
 await page.getByRole('button',{name:'Bandeja'}).click();
 assert.equal(await page.evaluate(()=>window.__testDesktop.windowState().minimized),true);
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
 // S25-REWORK: inspect dedicated compositions, not CSS-clipped full dashboard.
 await page.getByRole('button',{name:'Compacto'}).click();
 await page.setViewportSize({width:980,height:250});
 await page.locator('[data-layout="compact"]').waitFor();
 assert.equal(await page.locator('.project-banner:visible').count(),0,'Compact must not embed full dashboard');
 assert.equal(await page.locator('.px-room-agents .px-agent').count(),4);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+2),true,'Compact vertical overflow');
 await page.screenshot({path:join(folder,'s25-rework-compact.png')});
 await page.getByRole('button',{name:'Flutuante'}).click();
 await page.setViewportSize({width:660,height:390});
 await page.locator('[data-layout="floating"]').waitFor();
 assert.equal(await page.locator('.px-floating-side>div').count(),3);
 assert.equal(await page.locator('.content-grid:visible').count(),0,'Floating must not embed dashboard');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+2),true,'Floating vertical overflow');
 await page.screenshot({path:join(folder,'s25-rework-floating.png')});
 await page.getByRole('button',{name:'Taskbar'}).click();
 await page.setViewportSize({width:1000,height:135});
 await page.locator('[data-layout="taskbar"]').waitFor();
 assert.equal(await page.locator('.px-taskbar-people .px-agent').count(),4);
 assert.equal(await page.locator('.world-surface:visible').count(),0,'Taskbar must not render zoomed world dashboard');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+2),true,'Taskbar vertical overflow');
 await page.screenshot({path:join(folder,'s25-rework-taskbar.png')});
 await page.getByRole('button',{name:'Completo'}).click();
 await page.setViewportSize({width:1360,height:900});
 await page.locator('[data-layout="full"] .px-full-columns').waitFor();
 await page.locator('[data-layout="full"] canvas').waitFor();
 await page.screenshot({path:join(folder,'s25-rework-full.png')});
 console.log('PASS: S25-REWORK 4 dedicated mode layouts, no clipped dashboard, canonical agent counters, no vertical overflow (14/14)');
 await page.getByText('Projeto A tarefa real').first().waitFor();
 assert.equal(await page.getByRole('region',{name:'Alertas de intervenção'}).count(),0);
 await page.getByRole('button',{name:'Adicionar pasta…'}).click();
 await page.getByLabel('Projeto local').selectOption(projects[1].id);
 await page.getByRole('heading',{name:'Projeto B'}).waitFor();
 await page.getByRole('region',{name:'Alertas de intervenção'}).getByText('Projeto B revisão humana').waitFor();
 await page.getByRole('button',{name:'Ver eventos e evidências'}).click();
 await page.getByText('task.created').waitFor();
 // S27: native project-scoped attachment and escaped diff preview.
 await page.locator('#attachment-file-input').setInputFiles({
  name:'changes.diff',mimeType:'text/x-diff',
  buffer:Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+safe\n')
 });
 await page.getByRole('button',{name:'Enviar arquivo validado'}).click();
 await page.getByRole('button',{name:'Pré-visualizar changes.diff'}).waitFor();
 await page.getByRole('button',{name:'Pré-visualizar changes.diff'}).click();
 await page.getByLabel('Diff textual seguro').getByText('+safe').waitFor();
 assert.equal(await page.locator('.attachment-preview iframe').count(),0);
 assert.ok((await page.evaluate(()=>window.__testDesktop.calls())).includes('desktop_upload'));
 await page.screenshot({path:join(folder,'s27-native-diff-preview.png')});
 await page.locator('#attachment-file-input').setInputFiles({
  name:'sample.png',mimeType:'image/png',
  buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlBLeUAAAAASUVORK5CYII=','base64')
 });
 await page.getByRole('button',{name:'Enviar arquivo validado'}).click();
 await page.getByRole('button',{name:'Pré-visualizar sample.png'}).click();
 await page.getByRole('img',{name:'Imagem sample.png'}).waitFor();
 assert.ok((await page.getByRole('img',{name:'Imagem sample.png'}).getAttribute('src')).startsWith('data:image/png;base64,'));
 await page.locator('#attachment-file-input').setInputFiles({
  name:'document.pdf',mimeType:'application/pdf',
  buffer:Buffer.from('%PDF-1.4\n% passive test\n%%EOF','utf8')
 });
 await page.getByRole('button',{name:'Enviar arquivo validado'}).click();
 await page.getByRole('button',{name:'Pré-visualizar document.pdf'}).click();
 await page.getByText('PDF não é renderizado dentro do aplicativo por segurança.').waitFor();
 assert.equal(await page.locator('.attachment-preview iframe,.attachment-preview embed,.attachment-preview object').count(),0);
 console.log('PASS: S27 native upload, project-scoped metadata, diff/image preview, PDF no-inline and save link (11/11)');
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
