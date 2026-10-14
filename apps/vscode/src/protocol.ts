export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);

export type WebviewRequest =
 | {type:'ready'}
 | {type:'refresh'}
 | {type:'selectProject';projectId:string}
 | {type:'inspectTask';taskId:string};

export type Project={id:string;name:string};
export type Task={id:string;projectId:string;title:string;status:string;version:number;updatedAt:string;createdAt:string};
export type OfficeEvent={schemaVersion:number;sequence:number;projectId:string;taskId:string;eventId:string;type:string;occurredAt:string;actor:{kind:string};payload?:{from?:string;to?:string}};
export type Snapshot={project:Project;projects:Project[];tasks:Task[];events:OfficeEvent[];historyComplete:boolean;updatedAt:string};
export type HostMessage=
 | {type:'snapshot';value:Snapshot}
 | {type:'error';message:string}
 | {type:'waiting';message:string}
 | {type:'task';value:Task|null};
export function parseRequest(input:unknown):WebviewRequest|null{
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const obj=input as Record<string,unknown>,keys=Object.keys(obj);
 if((obj.type==='ready'||obj.type==='refresh')&&keys.length===1)return {type:obj.type};
 if(obj.type==='selectProject'&&keys.length===2&&isUuid(obj.projectId))return {type:'selectProject',projectId:obj.projectId};
 if(obj.type==='inspectTask'&&keys.length===2&&isUuid(obj.taskId))return {type:'inspectTask',taskId:obj.taskId};
 return null;
}
