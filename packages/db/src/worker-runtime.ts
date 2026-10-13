import {setTimeout as delay} from 'node:timers/promises';
import type {WorkerJob} from './worker-queue.ts';
import {WorkerQueue} from './worker-queue.ts';

export type WorkHandler=(job:WorkerJob,signal:AbortSignal)=>Promise<Record<string,unknown>>;
export class WorkerRuntime {
 private readonly queue:WorkerQueue;
 private readonly workerId:string;
 private readonly leaseMs:number;
 private readonly projectId?:string;
 constructor(queue:WorkerQueue,workerId:string,leaseMs=1500,projectId?:string){
  this.queue=queue;this.workerId=workerId;this.leaseMs=leaseMs;this.projectId=projectId;
 }
 async once(handler:WorkHandler,onClaim?:(job:WorkerJob)=>void):Promise<'idle'|'succeeded'|'retry'|'failed'|'cancelled'|'lost'>{
  await this.queue.reapExpired(50,this.projectId);
  const job=await this.queue.claim(this.workerId,this.leaseMs,this.projectId);
  if(!job)return 'idle';
  onClaim?.(job);
  const abort=new AbortController();
  let stopped=false,busy=false;
  const heartbeat=async()=>{
   if(stopped||busy)return;
   busy=true;
   try{
    const valid=await this.queue.heartbeat(job.id,this.workerId,job.leaseToken!,this.leaseMs);
    if(!valid)abort.abort();
   }catch{abort.abort();}
   finally{busy=false;}
  };
  const timer=setInterval(()=>{void heartbeat();},Math.max(50,Math.floor(this.leaseMs/3)));
  try{
   const output=await handler(job,abort.signal);
   if(abort.signal.aborted)return 'lost';
   const committed=await this.queue.complete(job.id,this.workerId,job.leaseToken!,output);
   return committed?'succeeded':'lost';
  }catch(err){
   const result=await this.queue.fail(job.id,this.workerId,job.leaseToken!,
    abort.signal.aborted?'Worker interrupted':err instanceof Error?err.message:String(err),100);
   return result==='cancelled'?'cancelled':result==='failed'?'failed':result===null?'lost':'retry';
  }finally{
   stopped=true;clearInterval(timer);
  }
 }
}
export async function simulatedWork(job:WorkerJob,signal:AbortSignal,delayMs=100):Promise<Record<string,unknown>>{
 // Deliberately NO LLM calls, terminal commands or filesystem side effects.
 if(!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>60000)throw Error('Invalid simulated duration');
 await delay(delayMs,undefined,{signal});
 return {kind:'s06-simulated-work',runId:job.runId,attempt:job.attemptCount};
}
