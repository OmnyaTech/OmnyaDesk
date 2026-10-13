import type {FastifyReply,FastifyRequest} from 'fastify';
import type {TaskOrchestrator} from '../../../packages/db/src/orchestration.ts';
import type {TokenStore,AuthPrincipal} from '../../../packages/db/src/tokens.ts';

export const SSE_POLL_MS=150;
export const SSE_AUTH_RECHECK_MS=1000;
export const SSE_HEARTBEAT_MS=10000;
export const SSE_MAX_CLIENTS=16;
const BATCH_PAGES_PER_POLL=4;
const DRAIN_TIMEOUT_MS=3000;

export function parseSseCursor(header:unknown,after?:number):number{
 if(header!==undefined){
  if(typeof header!=='string'||!/^\d{1,16}$/.test(header)||!Number.isSafeInteger(Number(header)))
   throw Object.assign(new Error('Invalid Last-Event-ID'),{statusCode:400});
  return Number(header);
 }
 if(after===undefined)return 0;
 if(!Number.isSafeInteger(after)||after<0)throw Object.assign(new Error('Invalid cursor'),{statusCode:400});
 return after;
}

export class ProjectSseHub {
 private connected=0;
 private readonly flows:TaskOrchestrator;
 private readonly tokens:TokenStore;
 constructor(flows:TaskOrchestrator,tokens:TokenStore){this.flows=flows;this.tokens=tokens;}
 activeConnections():number{return this.connected;}
 stream(req:FastifyRequest,reply:FastifyReply,actor:AuthPrincipal,cursor:number):void{
  if(this.connected>=SSE_MAX_CLIENTS)throw Object.assign(new Error('Too many active streams'),{statusCode:503});
  this.connected++;
  reply.hijack();
  const response=reply.raw;
  response.writeHead(200,{
   'content-type':'text/event-stream; charset=utf-8',
   'cache-control':'no-cache, no-transform',
   'connection':'keep-alive',
   'x-content-type-options':'nosniff',
   'x-accel-buffering':'no'
  });
  let active=true,lastId=cursor,nextTimer:NodeJS.Timeout|undefined;
  let lastHeartbeat=Date.now(),lastAuth=Date.now();
  const cleanup=()=>{
   if(!active)return;
   active=false;
   if(nextTimer)clearTimeout(nextTimer);
   this.connected--;
  };
  response.on('close',cleanup);
  response.on('error',cleanup);
  req.raw.on('aborted',cleanup);
  async function write(data:string):Promise<boolean>{
   if(!active||response.destroyed||response.writableEnded)return false;
   if(response.write(data))return true;
   // Slow clients do not accumulate unbounded user-space buffers.
   // Give the kernel/socket a bounded chance to drain before forcing replay.
   return new Promise<boolean>(resolve=>{
    const finish=(ok:boolean)=>{
     clearTimeout(timeout);
     response.off('drain',onDrain);
     response.off('close',onClose);
     if(!ok&&active){response.destroy();cleanup();}
     resolve(ok&&active);
    };
    const onDrain=()=>finish(true);
    const onClose=()=>finish(false);
    response.once('drain',onDrain);
    response.once('close',onClose);
    const timeout=setTimeout(()=>finish(false),DRAIN_TIMEOUT_MS);
    timeout.unref();
   });
  }
  response.write(': connected\n\n');
  const poll=async()=>{
   if(!active)return;
   try{
    if(Date.now()-lastAuth>=SSE_AUTH_RECHECK_MS){
     const fresh=await this.tokens.authenticate(req.headers.authorization);
     if(!active)return;
     if(!fresh||fresh.tokenId!==actor.tokenId||fresh.projectId!==actor.projectId||
        !fresh.scopes.includes('events:read')){
      response.end();
      cleanup();
      return;
     }
     lastAuth=Date.now();
    }
    let drained=false;
    for(let i=0;i<BATCH_PAGES_PER_POLL&&active;i++){
     const messages=await this.flows.listOutbox(actor.projectId,lastId);
     if(!active)return;
     for(const message of messages){
      if(message.id<=lastId)continue;
      if(!(await write('id: '+message.id+'\nevent: office\ndata: '+JSON.stringify(message)+'\n\n')))return;
      lastId=message.id;
     }
     if(messages.length<500){drained=true;break;}
    }
    if(!active)return;
    if(Date.now()-lastHeartbeat>=SSE_HEARTBEAT_MS){
     if(!(await write(': heartbeat\n\n')))return;
     lastHeartbeat=Date.now();
    }
    nextTimer=setTimeout(()=>{void poll();},drained?SSE_POLL_MS:0);
    nextTimer.unref();
   }catch{
    // No internal SQL errors, stack traces or bearer values in SSE payload.
    if(active){response.destroy();cleanup();}
   }
  };
  void poll();
 }
}
