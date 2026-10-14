import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';

if(process.platform!=='win32')throw Error('S26 native editor smoke requires Windows');
const exe='C:\\Program Files\\Microsoft VS Code\\Code.exe',qa='C:\\OmnyaDeskS26VSCodeQA';
const port=9351;
const child=spawn(exe,['--new-window','--user-data-dir='+qa+'\\user-data',
 '--extensions-dir='+qa+'\\extensions',
 '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,
 '--skip-welcome','--disable-telemetry'],{detached:false,stdio:'ignore'});
let browser;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 let ready=false;
 for(let i=0;i<40;i++){
  await sleep(450);
  try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');
   if(r.ok){ready=true;break;}}catch{/* transient editor readiness */}
 }
 assert.ok(ready,'VS Code CDP unavailable');
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
 let page;
 for(let i=0;i<30;i++){
  const pages=browser.contexts().flatMap(c=>c.pages());
  page=pages.find(p=>p.url().includes('workbench')||p.url().includes('vscode-file'))||pages[0];
  if(page){try{await page.locator('.monaco-workbench').waitFor({timeout:850});break;}catch{/* transient editor readiness */}}
  await sleep(250);
 }
 assert.ok(page,'No VS Code workbench page');
 console.log('INFO S26_CDP_WORKBENCH='+page.url().slice(0,140));
 await page.bringToFront();
 await page.keyboard.press('Control+Shift+P');
 await page.keyboard.type('OmnyaDesk: Abrir escritório',{delay:15});
 await sleep(800);
 const palette=await page.locator('body').innerText();
 assert.match(palette,/OmnyaDesk/,'No OmnyaDesk extension command in palette');
 await page.keyboard.press('Enter');
 await sleep(2800);
 let found=false;
 for(const p of browser.contexts().flatMap(c=>c.pages())){
  for(const frame of p.frames()){
   try{
    if(await frame.getByText('VISUALIZAÇÃO SOMENTE LEITURA',{exact:false}).count()){found=true;break;}
   }catch{/* transient editor readiness */}
  }
  if(found)break;
 }
 if(!found){
  console.log('INFO: pages='+browser.contexts().flatMap(c=>c.pages().map(p=>p.url())).join('|').slice(0,850));
  console.log('INFO: palette/workbench='+ (await page.locator('body').innerText()).slice(-600));
 }
 assert.ok(found,'OmnyaDesk read-only Webview not present after native VS Code command');
 console.log('PASS: S26 real VS Code isolated extension activation, command palette, and read-only Webview visible');
}finally{
 await browser?.close().catch(()=>undefined);
 child.kill();
}
