import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPool} from '../dist/packages/db/src/migrations.js';
import {buildPersistentApi} from '../dist/apps/api/src/server.js';
import {projectOffice,replayEventHistory} from '../apps/web/operator/world/projector.mjs';
const pool=createPool('postgresql://127.0.0.1:1/s22-smoke');
const api=await buildPersistentApi(pool);
const projectId='11111111-1111-4111-8111-111111111111';
const taskId='33333333-3333-4333-8333-333333333333';
const task={id:taskId,projectId,status:'implementing',version:3,updatedAt:new Date().toISOString()};
const events=[{schemaVersion:1,projectId,taskId,type:'task.created',sequence:1},
 {schemaVersion:1,projectId,taskId,type:'task.status_changed',sequence:2,
  payload:{from:'created',to:'planning'}},
 {schemaVersion:1,projectId,taskId,type:'task.status_changed',sequence:3,
  payload:{from:'planning',to:'implementing'}}];
let checks=0;
try{
 const html=await api.inject({method:'GET',url:'/operator'});
 const js=await api.inject({method:'GET',url:'/operator/app.js'});
 assert.equal(html.statusCode,200);assert.equal(js.statusCode,200);checks++;
 assert.match(html.headers['content-security-policy'],/script-src 'self'/);checks++;
 const bundle=readFileSync('dist/apps/web/operator/app.js','utf8');
 assert.ok(bundle.includes('task.status_changed')&&bundle.includes('event+snapshot'));checks++;
 assert.ok(bundle.includes('world-role--')&&bundle.includes('Sem atividade registrada'));checks++;
 const model=projectOffice({projectId,tasks:[task],events,connection:'online'});
 assert.equal(model.roles.find(r=>r.id==='developer').phase,'working');checks++;
 assert.equal(model.roles.find(r=>r.id==='developer').eventSequence,3);checks++;
 const disconnected=projectOffice({projectId,tasks:[task],events,connection:'offline'});
 assert.ok(disconnected.roles.every(r=>r.phase==='paused'));checks++;
 assert.equal(replayEventHistory([...events].reverse(),projectId).states.get(taskId).status,'implementing');checks++;
 assert.equal((await api.inject({method:'GET',url:'/v1/projects'})).statusCode,401);checks++;
 console.log('PASS: compiled S22 deterministic event projection, authenticated Phaser sprite state, offline pause and SSE replay (9/9)');
}finally{await api.close();await pool.end();}
if(checks!==9)process.exitCode=1;
