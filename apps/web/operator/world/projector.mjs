import {ROLES} from './layout.mjs';

const ACTIVE_STATUSES=Object.freeze({
 planning:'architect',implementing:'developer',testing:'qa',reviewing:'reviewer'
});
const TASK_STATES=new Set(['created','queued','planning','implementing','testing',
 'reviewing','awaiting_approval','approved','changes_requested','retrying',
 'blocked','failed','cancelled','expired']);
const MAX_REPLAY_EVENTS=3000;
const isValidSequence=value=>Number.isSafeInteger(value)&&value>0;
const isValidTask=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
const timestamp=value=>{const time=Date.parse(value??'');return Number.isFinite(time)?time:0;};

/** A deterministic, read-only reducer over authenticated API event pages. */
export function replayEventHistory(input,projectId){
 const events=Array.isArray(input)?input:[];
 const seen=new Set(),states=new Map();
 let applied=0,ignored=0,lastSequence=0;
 for(const event of events.slice().sort((a,b)=>(a?.sequence??0)-(b?.sequence??0))){
  if(!event||event.projectId!==projectId||event.schemaVersion!==1||
   !isValidSequence(event.sequence)||!isValidTask(event.taskId)||
   seen.has(event.sequence)){ignored++;continue;}
  seen.add(event.sequence);lastSequence=Math.max(lastSequence,event.sequence);
  if(event.type==='task.created'){
   if(!states.has(event.taskId)){states.set(event.taskId,{status:'created',sequence:event.sequence});applied++;}
   continue;
  }
  if(event.type!=='task.status_changed')continue;
  const from=event.payload?.from,to=event.payload?.to;
  if(!TASK_STATES.has(from)||!TASK_STATES.has(to)){ignored++;continue;}
  const before=states.get(event.taskId);
  if(before&&before.status!==from){ignored++;continue;}
  states.set(event.taskId,{status:to,sequence:event.sequence});applied++;
 }
 return {states,applied,ignored,lastSequence,recordCount:events.length};
}

/** Snapshot from /tasks remains authoritative; event replay annotates, never overrides it. */
export function projectOffice({projectId,tasks=[],events=[],connection='offline',
 historyComplete=true}={}){
 const replay=replayEventHistory(events,projectId);
 const connected=connection==='online';
 const verified=Array.isArray(tasks)?tasks.filter(task=>task?.projectId===projectId&&
  isValidTask(task.id)&&TASK_STATES.has(task.status)&&
  Number.isSafeInteger(task.version)&&task.version>0):[];
 const roles=ROLES.map(role=>{
  const matches=verified.filter(t=>ACTIVE_STATUSES[t.status]===role.id||
   (role.id==='reviewer'&&t.status==='awaiting_approval'));
  matches.sort((a,b)=>timestamp(b.updatedAt)-timestamp(a.updatedAt)||a.id.localeCompare(b.id));
  const primary=matches[0];
  const persistedState=primary?.status??null;
  const phase=!connected?'paused':!primary?'idle':
   persistedState==='awaiting_approval'?'waiting':'working';
  const recorded=replay.states.get(primary?.id);
  // Partial logs or in-flight state changes never authorize invented visual activity.
  const matched=!!recorded&&recorded.status===persistedState;
  return {id:role.id,name:role.name,station:role.station,phase,
   total:matches.length,taskId:primary?.id??null,
   status:persistedState,taskVersion:primary?.version??null,
   eventSequence:matched?recorded.sequence:null,
   evidence:matched?'event+snapshot':'snapshot'};
 });
 return {roles,connected,projectId:projectId??null,replay:{
  applied:replay.applied,ignored:replay.ignored,lastSequence:replay.lastSequence,
  complete:historyComplete&&events.length<MAX_REPLAY_EVENTS,
  matches:roles.filter(role=>role.eventSequence!==null).length
 }};
}
export function isReplayComplete(pageCount,pageLimit=500){
 return Number.isSafeInteger(pageCount)&&pageCount>=0&&pageCount<pageLimit;
}
export const REPLAY_MAX_EVENTS=MAX_REPLAY_EVENTS;
