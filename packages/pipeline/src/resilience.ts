import {setTimeout as delay} from 'node:timers/promises';
import {existsSync,readFileSync} from 'node:fs';
import {z} from 'zod';
import {
 AgentProviderEventSchema,ProviderCancelledError,ProviderExecutionError,
 type AgentProvider,type AgentExecutionRequest,type AgentProviderEvent,type AgentExecutionResult
} from '../../contracts/src/provider.ts';
import {
 executeFourRolePipeline,PipelineBlocked,type PipelineInput,type PipelineEvent,
 type CheckService,type PipelineResult,type PipelineRole
} from './four-role.ts';

// Mock-only S19 policy. A real, effectful provider must be separately authorized
// and fenced before any retry (S17/S18 live gates are still pending).
export const ResiliencePolicySchema=z.strictObject({
 timeoutMs:z.number().int().min(30).max(120000),
 maxInputTokens:z.number().int().min(0).max(1_000_000),
 maxOutputTokens:z.number().int().min(0).max(1_000_000),
 maxDeltaSteps:z.number().int().min(1).max(400),
 maxEstimatedCostUsd:z.number().finite().min(0).max(100),
 maxRetries:z.number().int().min(0).max(3),
 retryBaseMs:z.number().int().min(0).max(2000)
});
export type ResiliencePolicy=z.infer<typeof ResiliencePolicySchema>;
export type ResilienceEvent=
 |{type:'retry_scheduled';role:PipelineRole;attempt:number;delayMs:number;reason:'TRANSIENT_PROVIDER_ERROR'}
 |{type:'run_killed';reason:'OPERATOR_KILL'}
 |{type:'deadline_exceeded';timeoutMs:number}
 |{type:'budget_blocked';limit:'input_tokens'|'output_tokens'|'delta_steps'|'cost'};
export type UsageCounters={
 inputTokens:number;outputTokens:number;deltaSteps:number;estimatedCostUsd:number;
 providerAttempts:number;retries:number
};
export class ResilienceBlocked extends Error{
 readonly code:'KILLED'|'TIME_BUDGET_EXCEEDED'|'TOKEN_BUDGET_EXCEEDED'|'STEP_BUDGET_EXCEEDED'|'PIPELINE_FAILED';
 constructor(code:ResilienceBlocked['code']){
  super('Resilience controller blocked: '+code);this.name='ResilienceBlocked';this.code=code;
 }
}

function safeNext<T>(it:AsyncIterator<T>,signal:AbortSignal):Promise<IteratorResult<T>>{
 if(signal.aborted)return Promise.reject(new ProviderCancelledError());
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error?:unknown,value?:IteratorResult<T>)=>{
   if(settled)return;
   settled=true;signal.removeEventListener('abort',onAbort);
   if(error)reject(error);
   else resolve(value!);
  };
  const onAbort=()=>finish(new ProviderCancelledError());
  signal.addEventListener('abort',onAbort,{once:true});
  if(signal.aborted){onAbort();return;}
  Promise.resolve().then(()=>it.next()).then(
   v=>finish(undefined,v),e=>finish(e));
 });
}

function checkEnvelope(e:AgentProviderEvent,p:AgentProvider,r:AgentExecutionRequest,seq:number){
 if(e.providerId!==p.id||e.projectId!==r.projectId||e.taskId!==r.taskId||
  e.runId!==r.runId||e.sequence!==seq)
  throw new ProviderExecutionError('PROTOCOL_VIOLATION','Untrusted provider event identity or sequence');
}

export class MockResilienceController{
 private readonly policy:ResiliencePolicy;
 private readonly stop=new AbortController();
 private killed=false;
 private readonly mode:'mock'|'isolated-codex';
 constructor(policy:ResiliencePolicy,mode:'mock'|'isolated-codex'='mock'){
  this.policy=ResiliencePolicySchema.parse(policy);this.mode=mode;
  if(mode==='isolated-codex'&&(
   process.env.OMNYA_S19_ISOLATED_GUEST!=='1'||process.platform!=='linux'||
   !existsSync('/.dockerenv')||this.policy.maxRetries!==0))
   throw new ResilienceBlocked('PIPELINE_FAILED');
 }
 kill():void{this.killed=true;this.stop.abort();}
 get isKilled(){return this.killed;}

 async execute(input:PipelineInput,deps:{
  provider:AgentProvider;qaCheck:CheckService;reviewerCheck:CheckService;
  signal:AbortSignal;onEvent?:(event:PipelineEvent)=>void;
  onControlEvent?:(event:ResilienceEvent)=>void;
 }):Promise<{pipeline:PipelineResult;usage:UsageCounters}>{
  // The real mode is for the trusted read-only S12 Docker guest only, never API callers.
  if(deps.provider.id!==(this.mode==='mock'?'mock':'codex'))
   throw new ResilienceBlocked('PIPELINE_FAILED');
  if(this.mode==='isolated-codex'){
   const cwd=input.request.workspacePath;
   if(!/\/s12\/projects\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/workspace$/.test(cwd)||
    input.request.allowedTools.length!==0||!existsSync(cwd)||
    !readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>{
     const mount=line.split(' ');return mount[4]===cwd&&mount[5]?.split(',').includes('ro');
    }))throw new ResilienceBlocked('PIPELINE_FAILED');
  }
  if(this.killed)throw new ResilienceBlocked('KILLED');
  if(deps.signal.aborted)throw new ResilienceBlocked('KILLED');
  const ctl=new AbortController();
  // Telemetry is never trusted to authorize or block emergency cancellation.
  const notify=(e:ResilienceEvent)=>{try{deps.onControlEvent?.(e);}catch{/* non-authoritative observer */}};
  const onParent=()=>ctl.abort();
  const onKill=()=>{ctl.abort();notify({type:'run_killed',reason:'OPERATOR_KILL'});};
  deps.signal.addEventListener('abort',onParent,{once:true});
  this.stop.signal.addEventListener('abort',onKill,{once:true});
  if(deps.signal.aborted||this.stop.signal.aborted)ctl.abort();
  let timedOut=false;
  const limitState:{value:ResilienceEvent|null}={value:null};
  const policy=this.policy;
  const mode=this.mode;
  const timeout=setTimeout(()=>{
   timedOut=true;ctl.abort();notify({type:'deadline_exceeded',timeoutMs:this.policy.timeoutMs});
  },this.policy.timeoutMs);
  const usage:UsageCounters={
   inputTokens:0,outputTokens:0,deltaSteps:0,estimatedCostUsd:0,providerAttempts:0,retries:0
  };
  const wrapped:AgentProvider={id:deps.provider.id,
   run:async()=>{throw Error('Controller uses the validated event stream only');},
   stream:async function*(request:AgentExecutionRequest,signal:AbortSignal):AsyncIterable<AgentProviderEvent>{
    const role=request.role;
    const base={providerId:deps.provider.id,schemaVersion:1 as const,
     projectId:request.projectId,taskId:request.taskId,runId:request.runId};
    let outgoing=0;
    yield {...base,sequence:++outgoing,type:'started',modelId:request.modelId};
    for(let attempt=0;attempt<=policy.maxRetries;attempt++){
     if(signal.aborted){yield {...base,sequence:++outgoing,type:'cancelled',reason:'aborted'};return;}
     usage.providerAttempts++;
     let attemptSeq=0,attemptStarted=false,terminal:AgentProviderEvent|null=null;
     let deltaCount=0,deltaText='',it:AsyncIterator<AgentProviderEvent>|undefined;
     try{
      it=deps.provider.stream(request,signal)[Symbol.asyncIterator]();
      while(true){
       const next=await safeNext(it,signal);
       if(next.done)break;
       const e=AgentProviderEventSchema.parse(next.value);
       checkEnvelope(e,deps.provider,request,++attemptSeq);
       if(terminal)throw new ProviderExecutionError('PROTOCOL_VIOLATION','Event after terminal');
       if(!attemptStarted){
        if(e.type!=='started'||e.modelId!==request.modelId)
         throw new ProviderExecutionError('PROTOCOL_VIOLATION','Invalid provider start');
        attemptStarted=true;continue;
       }
       if(e.type==='started')throw new ProviderExecutionError('PROTOCOL_VIOLATION','Duplicate start');
       if(e.type==='delta'){
        deltaCount++;deltaText+=e.text;
        usage.deltaSteps++;
        if(usage.deltaSteps>policy.maxDeltaSteps){
         limitState.value={type:'budget_blocked',limit:'delta_steps'};
         notify(limitState.value);throw new ResilienceBlocked('STEP_BUDGET_EXCEEDED');
        }
        yield {...base,sequence:++outgoing,type:'delta',text:e.text};
       }else{
        terminal=e;
       }
      }
     }catch(err){
      if(signal.aborted){yield {...base,sequence:++outgoing,type:'cancelled',reason:'aborted'};return;}
      throw err;
     }finally{
      // Never await a possibly uncooperative provider after cancellation.
      if(it&&signal.aborted)void it.return?.().catch(()=>{});
     }
     if(!attemptStarted||!terminal)
      throw new ProviderExecutionError('PROTOCOL_VIOLATION','Provider ended without terminal');
     if(terminal.type==='cancelled'){
      yield {...base,sequence:++outgoing,type:'cancelled',reason:'aborted'};return;
     }
     if(terminal.type==='completed'){
      const result:AgentExecutionResult=terminal.result;
      if(result.output!==deltaText)
       throw new ProviderExecutionError('PROTOCOL_VIOLATION','Completion mismatches deltas');
      const nextInput=usage.inputTokens+result.usage.inputTokens;
      const nextOutput=usage.outputTokens+result.usage.outputTokens;
      const nextCost=usage.estimatedCostUsd+result.usage.costUsd;
      const limit=nextInput>policy.maxInputTokens?'input_tokens':
       nextOutput>policy.maxOutputTokens?'output_tokens':
       nextCost>policy.maxEstimatedCostUsd+1e-10?'cost':null;
      if(limit){
       limitState.value={type:'budget_blocked',limit};notify(limitState.value);
       yield {...base,sequence:++outgoing,type:'failed',
        error:{code:'QUOTA_EXCEEDED',message:'Global pipeline usage limit exceeded'}};return;
      }
      usage.inputTokens=nextInput;usage.outputTokens=nextOutput;usage.estimatedCostUsd=nextCost;
      yield {...base,sequence:++outgoing,type:'completed',result};return;
     }
     if(terminal.type!=='failed')throw new ProviderExecutionError('PROTOCOL_VIOLATION','Invalid terminal');
     // A retry is safe only for transient provider errors *before any output*,
     // with no tools, in the S16 mock. Never retry quota, protocol errors or
     // a partially streamed stage; that could duplicate work or side effects.
     const retryable=mode==='mock'&&terminal.error.code==='PROVIDER_ERROR'&&deltaCount===0&&
      attempt<policy.maxRetries;
     if(!retryable){
      yield {...base,sequence:++outgoing,type:'failed',
       error:{code:terminal.error.code,message:'Mock stage failed (details omitted)'}};return;
     }
     usage.retries++;
     const delayMs=Math.min(2000,policy.retryBaseMs*2**attempt);
     notify({type:'retry_scheduled',role,attempt:attempt+1,
      delayMs,reason:'TRANSIENT_PROVIDER_ERROR'});
     try{await delay(delayMs,undefined,{signal});}
     catch{yield {...base,sequence:++outgoing,type:'cancelled',reason:'aborted'};return;}
    }
   }};
  const checkWithAbort=(fn:CheckService):CheckService=>async(context,signal)=>{
   if(signal.aborted)throw new ProviderCancelledError();
   let onAbort:()=>void=()=>{};
   const stopped=new Promise<never>((_,reject)=>{
    onAbort=()=>reject(new ProviderCancelledError());
    signal.addEventListener('abort',onAbort,{once:true});
   });
   try{if(signal.aborted)throw new ProviderCancelledError();
    return await Promise.race([fn(context,signal),stopped]);
   }finally{signal.removeEventListener('abort',onAbort);}
  };
  try{
   // This pipeline is text-only, no tools. A completed mock never merges Git,
   // touches main or claims S15 human approval.
   const pipeline=await executeFourRolePipeline(input,{
    provider:wrapped,qaCheck:checkWithAbort(deps.qaCheck),
    reviewerCheck:checkWithAbort(deps.reviewerCheck),
    signal:ctl.signal,onEvent:deps.onEvent
   });
   if(timedOut)throw new ResilienceBlocked('TIME_BUDGET_EXCEEDED');
   if(this.killed||deps.signal.aborted)throw new ResilienceBlocked('KILLED');
   if(limitState.value){
    const blocked=limitState.value as Extract<ResilienceEvent,{type:'budget_blocked'}>;
    throw new ResilienceBlocked(blocked.limit==='delta_steps'?
     'STEP_BUDGET_EXCEEDED':'TOKEN_BUDGET_EXCEEDED');
   }
   return {pipeline,usage};
  }catch(err){
   if(timedOut)throw new ResilienceBlocked('TIME_BUDGET_EXCEEDED');
   if(this.killed||deps.signal.aborted)throw new ResilienceBlocked('KILLED');
   if(limitState.value){
    const blocked=limitState.value as Extract<ResilienceEvent,{type:'budget_blocked'}>;
    throw new ResilienceBlocked(blocked.limit==='delta_steps'?
     'STEP_BUDGET_EXCEEDED':'TOKEN_BUDGET_EXCEEDED');
   }
   if(err instanceof PipelineBlocked||err instanceof ProviderExecutionError)throw err;
   throw new ResilienceBlocked('PIPELINE_FAILED');
  }finally{
   clearTimeout(timeout);deps.signal.removeEventListener('abort',onParent);
   this.stop.signal.removeEventListener('abort',onKill);ctl.abort();
  }
 }
}
