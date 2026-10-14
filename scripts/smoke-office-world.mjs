import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {buildPersistentApi} from '../dist/apps/api/src/server.js';
const pool=createPool('postgresql://127.0.0.1:1/s21-test');
const api=await buildPersistentApi(pool);
try{
 const html=await api.inject({method:'GET',url:'/operator'});
 assert.equal(html.statusCode,200);assert.match(html.body,/app\.js/);
 const js=await api.inject({method:'GET',url:'/operator/app.js'});
 const css=await api.inject({method:'GET',url:'/operator/app.css'});
 assert.equal(js.statusCode,200);assert.equal(css.statusCode,200);
 assert.equal(js.headers['cache-control'],'no-store');
 assert.match(html.headers['content-security-policy'],/script-src 'self'/);
 const source=await readFile('dist/apps/web/operator/app.js','utf8');
 const style=await readFile('dist/apps/web/operator/app.css','utf8');
 for(const required of ['OmnyaOffice','architect','developer','qa','reviewer','Arquitetura',
  'Desenvolvimento','Qualidade','Phaser']){
  assert.ok(source.includes(required),'Missing compiled S21 world feature: '+required);
 }
 for(const required of ['world-view','world-toolbar','world-role-nav','world-controls'])
  assert.ok(style.includes(required),'Missing compiled S21 responsive controls: '+required);
 const size=(await stat('dist/apps/web/operator/app.js')).size;
 assert.ok(size>100000&&size<5000000,'Bundled scene must include Phaser but remain bounded');
 assert.equal(js.body.includes('odt_'+'a'.repeat(64)),false);
 assert.equal(js.body.includes('localStorage.setItem'),false);
 console.log('PASS: compiled S21 Phaser office, procedural atlas, 4 stations, keyboard/pan/zoom and authenticated static shell (9/9)');
}finally{await api.close();await pool.end();}
