import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectOffice,replayEventHistory,isReplayComplete,REPLAY_MAX_EVENTS}
 from '../apps/web/operator/world/projector.mjs';
const p='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const id='33333333-3333-4333-8333-333333333333';
const task=(status:string,extra:Record<string,unknown>={})=>({id,projectId:p,status,version:2,
 updatedAt:'2026-10-13T20:00:00Z',...extra});
const created=(sequence=1,projectId=p)=>({sequence,schemaVersion:1,
 projectId,taskId:id,type:'task.created',payload:{title:'test'}});
const changed=(sequence:number,from:string,to:string,projectId=p)=>({sequence,schemaVersion:1,
 projectId,taskId:id,type:'task.status_changed',payload:{from,to}});
const role=(result:ReturnType<typeof projectOffice>,name:string)=>{const found=result.roles.find(x=>x.id===name);if(!found)throw Error('No projected role');return found;};

test('S22 maps only canonical persisted active statuses to their exact four roles',()=>{
 for(const [state,expected] of [['planning','architect'],['implementing','developer'],
  ['testing','qa'],['reviewing','reviewer']]){
  const projected=projectOffice({projectId:p,tasks:[task(state)],connection:'online'});
  assert.deepEqual(projected.roles.filter(x=>x.phase==='working').map(x=>x.id),[expected]);
  assert.equal(role(projected,expected).evidence,'snapshot');
 }
});
test('S22 waiting for human review does not animate a running agent',()=>{
 const view=projectOffice({projectId:p,tasks:[task('awaiting_approval')],connection:'online'});
 assert.equal(view.roles.some(x=>x.phase==='working'),false);
 assert.equal(role(view,'reviewer').phase,'waiting');
});
test('S22 final, queued, failed, retrying and unknown statuses never invent animation',()=>{
 for(const status of ['queued','created','approved','cancelled','failed','blocked','retrying','expired',
  'changes_requested','unknown']){
  const view=projectOffice({projectId:p,tasks:[task(status)],connection:'online'});
  assert.equal(view.roles.some(x=>x.phase==='working'),false,status);
 }
});
test('S22 offline and rehydrating both suspend all activity despite a previously active task',()=>{
 for(const connection of ['offline','syncing','denied']){
  const view=projectOffice({projectId:p,tasks:[task('implementing')],connection});
  assert.deepEqual(view.roles.map(x=>x.phase),['paused','paused','paused','paused']);
 }
});
test('S22 event reducer is deterministic, sorted, idempotent and project scoped',()=>{
 const history=[changed(3,'planning','implementing'),changed(2,'created','planning'),
  created(),created(),changed(5,'implementing','testing',other)];
 const replay=replayEventHistory(history,p);
 assert.equal(replay.states.get(id)?.status,'implementing');
 assert.equal(replay.states.get(id)?.sequence,3);
 assert.equal(replay.applied,3);assert.equal(replay.ignored,2);
 assert.equal(replay.lastSequence,3);
 assert.deepEqual(replayEventHistory(history.slice().reverse(),p),replay);
});
test('S22 stale and contradictory domain events cannot override database snapshot',()=>{
 const events=[created(),changed(2,'created','planning'),changed(3,'created','approved')];
 const view=projectOffice({projectId:p,tasks:[task('testing')],events,connection:'online'});
 assert.equal(role(view,'qa').phase,'working');
 assert.equal(role(view,'qa').status,'testing');
 assert.equal(role(view,'qa').eventSequence,null);
 assert.equal(view.replay.ignored,1);
});
test('S22 replayed event must match authoritative task status to be attributed as proof',()=>{
 const events=[created(),changed(2,'created','planning'),changed(3,'planning','implementing')];
 const view=projectOffice({projectId:p,tasks:[task('implementing')],events,connection:'online'});
 assert.equal(role(view,'developer').eventSequence,3);
 assert.equal(role(view,'developer').evidence,'event+snapshot');
 assert.equal(view.replay.matches,1);
});
test('S22 malicious cross-tenant tasks never drive avatars despite injected projectId',()=>{
 const view=projectOffice({projectId:p,tasks:[task('planning',{projectId:other}),
  task('implementing',{version:-1}),task('reviewing',{id:'../../../../tmp'})],
 events:[changed(9,'planning','implementing',other)],connection:'online'});
 assert.equal(view.roles.some(x=>x.phase==='working'),false);
 assert.equal(view.replay.applied,0);
});
test('S22 tie-breaking uses updated timestamp then immutable ID, not array order',()=>{
 const second='44444444-4444-4444-8444-444444444444';
 const a=task('planning',{updatedAt:'2026-10-13T10:00:00Z'});
 const b=task('planning',{id:second,updatedAt:'2026-10-13T11:00:00Z'});
 assert.equal(role(projectOffice({projectId:p,tasks:[a,b],connection:'online'}),'architect').taskId,second);
 assert.equal(role(projectOffice({projectId:p,tasks:[b,a],connection:'online'}),'architect').taskId,second);
});
test('S22 bounded pagination explicitly marks truncated history without fabricating missing events',()=>{
 assert.equal(REPLAY_MAX_EVENTS,3000);
 assert.equal(isReplayComplete(499),true);
 assert.equal(isReplayComplete(500),false);
 assert.equal(isReplayComplete(0),true);
 const view=projectOffice({projectId:p,tasks:[task('planning')],events:[created()],
 connection:'online',historyComplete:false});
 assert.equal(view.replay.complete,false);
 assert.equal(role(view,'architect').phase,'working');
});
test('S22 event validation rejects untrusted future schemas and malformed lifecycle payload',()=>{
 const history=[created(),{...changed(2,'created','approved'),schemaVersion:2},
  changed(3,'foo','implementing'),
  {...changed(4,'created','planning'),sequence:NaN}];
 const replay=replayEventHistory(history,p);
 assert.equal(replay.states.get(id)?.status,'created');
 assert.equal(replay.applied,1);
 assert.equal(replay.ignored,3);
});
