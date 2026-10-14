import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import Module from 'node:module';
import {readFile} from 'node:fs/promises';
import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';
import {createServer} from 'node:http';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const p='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const t='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token='odt_'+'a'.repeat(64);
const calls=[],messages=[],commands={};
let listener,disposeListener,deleted=false,secret=token;
const context={extensionUri:{path:'/synthetic/omnyadesk'},secrets:{
 get:async()=>secret,store:async(_key,value)=>{secret=value;},delete:async()=>{secret=undefined;deleted=true;}
 },subscriptions:[]};
const webview={
 cspSource:'vscode-resource:',asWebviewUri:uri=>({toString:()=>uri.path}),
 postMessage:async m=>{messages.push(m);return true;},
 onDidReceiveMessage:fn=>{listener=fn;return {dispose(){}}},html:''
};
const panel={webview,visible:true,reveal(){},onDidDispose(fn){disposeListener=fn;return {dispose(){}}},dispose(){disposeListener?.();}};
const vscode={ViewColumn:{Beside:2},Uri:{joinPath:(base,...parts)=>({path:base.path+'/'+parts.join('/')})},
 workspace:{getConfiguration:()=>({get:()=>4317})},
 commands:{registerCommand:(name,fn)=>{commands[name]=fn;return {dispose(){}}}},
 window:{createWebviewPanel:()=>panel,showInputBox:async()=>undefined,showInformationMessage:async()=>undefined}};
const orig=Module._load;
Module._load=function(name,...args){if(name==='vscode')return vscode;return orig.call(this,name,...args);};
const ext=require('../apps/vscode/dist/extension.cjs');
Module._load=orig;
const fakeFetch=async(url,opts)=>{
 assert.equal(new URL(url).hostname,'127.0.0.1');
 assert.equal(opts.headers.Authorization,'Bearer '+token);
 assert.equal(opts.method,'GET');
 assert.equal(opts.redirect,'error');
 calls.push(url);
 let data;
 if(url.endsWith('/v1/projects'))data={projects:[{id:p,name:'Projeto Seguro'}]};
 else if(url.endsWith('/git/integrations'))data={integrations:[{id:other,taskId:t,state:'ready'}]};
 else if(url.endsWith('/git/integrations/'+other))data={integration:{id:other,projectId:p,taskId:t,state:'ready',reviewHash:'c'.repeat(64),review:{diff:'+<img src=x onerror=alert(1)>\\n+S29_SAFE_DIFF'}}};
 else if(url.endsWith('/tasks'))data={tasks:[
  {id:t,projectId:p,title:'Executar validação',status:'implementing',version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},
  {id:other,projectId:other,title:'INTRUSO',status:'implementing',version:1}]};
 else data={events:[{schemaVersion:1,sequence:1,eventId:t,projectId:p,taskId:t,type:'task.created',occurredAt:new Date().toISOString(),actor:{kind:'system'}},
   {schemaVersion:1,sequence:2,eventId:other,projectId:other,taskId:t,type:'task.status_changed',payload:{from:'created',to:'implementing'}}]};
 return {ok:true,status:200,headers:new Map([['content-length','32']]),text:async()=>JSON.stringify(data)};
};
const gateway=new ext.LocalReadGateway(async()=>token,()=>4317,fakeFetch);
const projects=await gateway.projects();
assert.equal(projects.length,1);
const snapshot=await gateway.snapshot(p,projects);
assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.events.length,1);
assert.equal(JSON.stringify(snapshot).includes(token),false);
await assert.rejects(()=>gateway.snapshot(other,projects),/fora do escopo/);
await assert.rejects(()=>new ext.LocalReadGateway(async()=>token,()=>80,fakeFetch).projects(),/Porta local/);
const verified=await gateway.taskReview(p,t,projects);
assert.equal(verified?.reviewHash,'c'.repeat(64));
assert.ok(verified?.diff.includes('S29_SAFE_DIFF'));
await assert.rejects(()=>gateway.taskReview(other,t,projects),/fora do escopo/);
assert.equal(calls.length,5,'Only project-scoped GETs including validated diff from host allowed');
const html=ext.webviewHtml(webview,context.extensionUri);
assert.match(html,/connect-src 'none'/);
assert.match(html,/script-src 'nonce-[^']+'/);
assert.doesNotMatch(html,/unsafe-inline|unsafe-eval|odt_[a-f0-9]{64}/);
assert.match(html,/local|vscode-resource/);
ext.activate(context);
assert.equal(typeof commands['omnyadesk.openOffice'],'function');
assert.equal(typeof commands['omnyadesk.disconnect'],'function');
commands['omnyadesk.openOffice']();
assert.ok(webview.html.includes('Content-Security-Policy'));
listener({type:'selectProject',projectId:other});
listener({type:'inspectTask',taskId:other});
assert.equal(messages.filter(m=>m.type==='task').at(-1)?.value,null);
listener({type:'selectProject',projectId:p,extraneous:'unsafe'});
await commands['omnyadesk.disconnect']();
assert.ok(deleted&&!secret);panel.dispose();
console.log('PASS: S26 typed bridge project-scoped GET-only SecretStorage/CSP, no token in Webview, invalid inputs rejected (18/18)');

if(!process.argv.includes('--host-only')){
const path=join(process.cwd(),'apps/vscode/dist');
const server=createServer(async(req,res)=>{
 const name=new URL(req.url??'/', 'http://127.0.0.1').pathname.slice(1)||'index.html';
 if(!['index.html','webview.js','webview.css'].includes(name)){res.writeHead(404).end();return;}
 res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
 res.end(name==='index.html'?html.replace(/\/synthetic\/omnyadesk\/dist\//g,'/'):await readFile(join(path,name)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 const executable=process.env.OMNYA_S20_BROWSER||(process.platform==='win32'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':'/usr/bin/chromium');
 browser=await chromium.launch({executablePath:executable,headless:true});
 const page=await browser.newPage({viewport:{width:1200,height:850}});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:obj=>window.__posted.push(obj)});});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.waitForFunction(()=>window.__posted.some(m=>m.type==='ready'));
 await page.evaluate(snapshot=>window.dispatchEvent(new MessageEvent('message',{data:{type:'snapshot',value:snapshot}})),snapshot);
 await page.getByRole('heading',{name:/Escritório 2D/}).waitFor();
 await page.locator('[data-office-map="phaser"] canvas').waitFor();
 await page.getByRole('button',{name:'Atualizar'}).click();
 assert.ok(await page.evaluate(()=>window.__posted.some(m=>m.type==='refresh')));
 await page.evaluate(({task,review})=>{
  window.__injected=false;
  window.alert=()=>{window.__injected=true;};
  window.dispatchEvent(new MessageEvent('message',{data:{type:'task',value:task}}));
  window.dispatchEvent(new MessageEvent('message',{data:{type:'review',value:review}}));
 },{task:snapshot.tasks[0],review:verified});
 await page.getByRole('region',{name:'Detalhes da tarefa'}).waitFor();
 await page.getByRole('region',{name:'Diff de revisão Git'}).waitFor();
 assert.ok(await page.getByRole('region',{name:'Diff de revisão Git'}).getByText('S29_SAFE_DIFF',{exact:false}).count());
 assert.equal(await page.evaluate(()=>window.__injected),false);
 assert.equal(await page.locator('.office-review-diff img').count(),0);
 console.log('PASS: S29 VS Code read-only verified Git diff visible; malicious HTML rendered as text; no token to Webview (5/5)');
 assert.equal(errors.length,0,errors.join('; '));
 await page.screenshot({path:join(process.cwd(),'apps/vscode/dist/s26-webview.png'),fullPage:true});
 console.log('PASS: S26 browser Phaser canvas, snapshot render, refresh messages, no runtime errors (4/4)');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}else console.log('INFO: VS Code Chromium Webview browser test is run separately in the Windows QA gate.');
