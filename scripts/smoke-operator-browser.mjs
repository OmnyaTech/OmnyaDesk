/* global localStorage, sessionStorage, location, document, window */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';

const TOKEN='odt_'+'a'.repeat(64);
const PROJECT='11111111-1111-4111-8111-111111111111';
const TASK='22222222-2222-4222-8222-222222222222';
let status='planning',projectCalls=0;
const sockets=new Set();
const folder=join(process.cwd(),'dist','apps','web','operator');
const assets=new Map([
 ['/operator',['index.html','text/html; charset=utf-8']],
 ['/operator/app.js',['app.js','text/javascript; charset=utf-8']],
 ['/operator/app.css',['app.css','text/css; charset=utf-8']]
]);
const now=new Date().toISOString();
const project={id:PROJECT,name:'S20 projeto sintético',createdAt:now,updatedAt:now};
const task=()=>({id:TASK,projectId:PROJECT,officeId:PROJECT,requestedBy:PROJECT,
 title:'Revisar execução de testes S20',description:'Cenário de integração sintética.',
 status,version:status==='planning'?2:3,currentRunId:PROJECT,createdAt:now,updatedAt:now});
const entry={id:PROJECT,projectId:PROJECT,taskId:TASK,runId:PROJECT,kind:'log',
 scopeKey:'synthetic',actorId:'test',version:1,contentSha256:'b'.repeat(64),
 chainSha256:'c'.repeat(64),previousChain:null,createdAt:now};
const ev=()=>({schemaVersion:1,eventId:PROJECT,sequence:1,occurredAt:now,
 projectId:PROJECT,taskId:TASK,type:'task.created',actor:{kind:'system'}});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url||'/', 'http://localhost');
 const path=url.pathname;
 const asset=assets.get(path);
 if(asset){
  const [name,type]=asset;
  res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
  res.end(await readFile(join(folder,name)));return;
 }
 res.setHeader('content-type','application/json; charset=utf-8');
 res.setHeader('cache-control','no-store');
 if(path==='/v1/projects')projectCalls++;
 if(req.headers.authorization!=='Bearer '+TOKEN){res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
 if(path==='/v1/projects'){res.end(JSON.stringify({projects:[project]}));return;}
 if(path==='/v1/projects/'+PROJECT+'/tasks'){res.end(JSON.stringify({tasks:[task()]}));return;}
 if(path==='/v1/projects/'+PROJECT+'/events'){res.end(JSON.stringify({events:[ev()]}));return;}
 if(path==='/v1/projects/'+PROJECT+'/tasks/'+TASK+'/evidence'){res.end(JSON.stringify({evidence:[entry]}));return;}
 if(path==='/v1/projects/'+PROJECT+'/stream'){
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  res.write(': ready\n\n');sockets.add(res);req.on('close',()=>sockets.delete(res));return;
 }
 res.writeHead(404);res.end('{"error":"not-found"}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const target='http://127.0.0.1:'+port+'/operator';
const browserPath=process.env.OMNYA_S20_BROWSER||
 (process.platform==='win32'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':'/usr/bin/chromium');
let browser;
try{
 browser=await chromium.launch({executablePath:browserPath,headless:true,
  args:['--disable-background-networking','--disable-extensions']});
 const context=await browser.newContext({viewport:{width:1440,height:900},
  serviceWorkers:'block'});
 const page=await context.newPage();
 const errors=[];
 page.on('pageerror',err=>errors.push(err.message));
 await page.goto(target,{waitUntil:'load'});
 await page.getByRole('heading',{name:'Conecte seu projeto'}).waitFor();
 await page.getByLabel('Token de acesso').fill('invalid');
 await page.getByRole('button',{name:'Conectar com segurança'}).click();
 await page.getByRole('alert').getByText('Informe uma credencial Bearer válida.').waitFor();
 assert.equal(projectCalls,0,'invalid token must never hit API');
 await page.getByLabel('Token de acesso').fill(TOKEN);
 await page.getByRole('button',{name:'Conectar com segurança'}).click();
 await page.getByRole('heading',{name:'S20 projeto sintético'}).waitFor();
 await page.getByRole('button',{name:'Abrir detalhes de Revisar execução de testes S20'}).click();
 await page.getByText('SHA-256 cccccccc…').waitFor();
 await page.getByText('task.created').waitFor();
 await page.getByRole('button',{name:'Fechar detalhes'}).click();
 await page.getByPlaceholder('Buscar tarefa por título…').fill('nada encontrado');
 await page.getByText('Nenhuma tarefa encontrada').waitFor();
 await page.getByPlaceholder('Buscar tarefa por título…').fill('');
 await page.getByRole('status').getByText('Tempo real ativo').waitFor();
 status='awaiting_approval';
 for(const socket of sockets)socket.write('id: 2\nevent: office\ndata: {"id":2}\n\n');
 await page.getByText('Aguardando revisão',{exact:true}).first().waitFor();
 const secrets=await page.evaluate(()=>({
  ls:Object.keys(localStorage),ss:Object.keys(sessionStorage),
  url:location.href
 }));
 assert.deepEqual(secrets.ls,[]);assert.deepEqual(secrets.ss,[]);
 assert.ok(!secrets.url.includes('odt_'));
 assert.equal(await page.getByRole('button',{name:'Aprovar'}).count(),0);
 await page.screenshot({path:join(process.cwd(),'dist','apps','web','operator','s20-desktop-smoke.png')});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:join(process.cwd(),'dist','apps','web','operator','s20-mobile-smoke.png')});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
 if(overflow>3){const offenders=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>window.innerWidth+4).slice(0,12).map(el=>({node:el.tagName,className:String(el.className).slice(0,60),width:Math.round(el.getBoundingClientRect().width),right:Math.round(el.getBoundingClientRect().right)})));console.log('S20_MOBILE_OVERFLOW_CLASSES='+JSON.stringify(offenders));}
 assert.ok(overflow<=3,'Mobile layout has horizontal overflow: '+overflow);
 await page.getByRole('button',{name:'Sair'}).click();
 await page.getByRole('heading',{name:'Conecte seu projeto'}).waitFor();
 await page.reload();
 await page.getByRole('heading',{name:'Conecte seu projeto'}).waitFor();
 assert.deepEqual(errors,[],'Browser console runtime exception');
 console.log('PASS: S20 headless browser auth, filters, task details, SHA evidence, SSE refresh, ephemeral token, mobile layout and logout (14/14)');
 await context.close();
}finally{
 await browser?.close();
 for(const socket of sockets)socket.end();
 await new Promise(resolve=>server.close(resolve));
}
