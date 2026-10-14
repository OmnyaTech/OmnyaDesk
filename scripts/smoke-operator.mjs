import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {buildPersistentApi} from '../dist/apps/api/src/server.js';
const pool=createPool(process.env.DATABASE_URL||
 'postgresql://127.0.0.1:1/s20-mock');
const api=await buildPersistentApi(pool);
let count=0;
try{
 const page=await api.inject({method:'GET',url:'/operator'});
 assert.equal(page.statusCode,200);count++;
 assert.match(page.body,/lang="pt-BR"/);
 assert.match(page.body,/id="root"/);
 assert.match(page.body,/app\.js/);count++;
 assert.match(page.headers['content-security-policy'],/default-src 'none'/);
 assert.match(page.headers['content-security-policy'],/connect-src 'self'/);
 assert.equal(page.headers['x-frame-options'],'DENY');
 assert.equal(page.headers['cache-control'],'no-store');count++;
 const js=await api.inject({method:'GET',url:'/operator/app.js'});
 const css=await api.inject({method:'GET',url:'/operator/app.css'});
 assert.equal(js.statusCode,200);assert.equal(css.statusCode,200);count++;
 assert.match(js.headers['content-type'],/javascript/);
 assert.match(css.headers['content-type'],/text\/css/);
 assert.ok(js.body.length>20000&&css.body.length>1000);count++;
 assert.match(js.body,/projects/);assert.match(js.body,/stream/);
 assert.match(js.body,/evidence/);count++;
 assert.ok(!js.body.includes('odt_'+'f'.repeat(64)));
 const appSource=await readFile('apps/web/operator/app.jsx','utf8');
 const sceneSource=await readFile('apps/web/operator/world/OfficeWorld.jsx','utf8');
 // Third-party Phaser may reference storage APIs in its runtime, but first-party
 // operator code must never store Bearer credentials. Browser E2E asserts empty
 // localStorage/sessionStorage after login, logout and reload.
 for(const owned of [appSource,sceneSource])
  assert.ok(!/localStorage|sessionStorage/.test(owned),'First-party storage access prohibited');
 assert.ok(!page.body.includes('unsafe-inline'));count++;
 const unauthorized=await api.inject({method:'GET',url:'/v1/projects'});
 assert.equal(unauthorized.statusCode,401);count++;
 const direct=await readFile('dist/apps/web/operator/app.js','utf8');
 assert.ok(direct.includes('Bearer')&&direct.includes('application/json'));count++;
 console.log('PASS: compiled S20 React static assets, CSP, bearer-only v1 access, scoped operator navigation (9/9)');
}finally{await api.close();await pool.end();}
if(count!==9)process.exitCode=1;
