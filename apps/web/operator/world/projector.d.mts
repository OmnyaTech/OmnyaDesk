export type OfficeRoleId='architect'|'developer'|'qa'|'reviewer';
export interface ProjectedTask{
 id:string;projectId:string;status:string;version:number;updatedAt?:string|null;
}
export interface EventRecord{
 schemaVersion?:number;sequence?:number;projectId?:string;taskId?:string;type?:string;
 payload?:{from?:string;to?:string};
}
export interface OfficeRoleProjection{
 id:OfficeRoleId;name:string;station:string;
 phase:'working'|'waiting'|'paused'|'idle';
 total:number;taskId:string|null;status:string|null;taskVersion:number|null;
 eventSequence:number|null;evidence:'event+snapshot'|'snapshot';
}
export interface OfficeProjection{
 roles:OfficeRoleProjection[];connected:boolean;projectId:string|null;
 replay:{applied:number;ignored:number;lastSequence:number;complete:boolean;matches:number};
}
export function replayEventHistory(events:readonly unknown[],projectId:string):
 {states:Map<string,{status:string;sequence:number}>;applied:number;ignored:number;lastSequence:number;recordCount:number};
export function projectOffice(options?:{
 projectId?:string|null;tasks?:readonly ProjectedTask[];events?:readonly unknown[];
 connection?:string;historyComplete?:boolean
}):OfficeProjection;
export function isReplayComplete(pageCount:number,pageLimit?:number):boolean;
export const REPLAY_MAX_EVENTS:number;
