import {decodeDomainEventV1,type VersionedDomainEventV1} from '../../contracts/src/events.ts';

export type StreamMessage={id:number;event:VersionedDomainEventV1};
export class ReplayCursor {
 private lastId:number;
 readonly projectId:string;
 constructor(projectId:string,after=0){
  this.projectId=projectId;
  if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid initial SSE cursor');
  this.lastId=after;
 }
 value():number{return this.lastId;}
 lastEventId():string{return String(this.lastId);}
 ingest(value:StreamMessage):boolean{
  if(!Number.isSafeInteger(value.id)||value.id<=0)throw Error('Invalid event cursor');
  const event=decodeDomainEventV1(value.event);
  if(event.projectId!==this.projectId)throw Error('Cross-project event rejected');
  if(value.id<=this.lastId)return false; // duplicate/older frame after reconnect
  this.lastId=value.id;
  return true;
 }
}
