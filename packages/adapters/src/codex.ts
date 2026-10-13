import {existsSync,realpathSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Codex,type ThreadEvent} from '@openai/codex-sdk';
import {z} from 'zod';
import {
 AgentExecutionRequestSchema,AgentProviderEventSchema,executeProvider,
 ProviderExecutionError,type AgentProvider,type AgentExecutionRequest,
 type AgentExecutionResult,type AgentProviderEvent
} from '../../contracts/src/provider.ts';

type StreamSource={runStreamed:(prompt:string,opts:{signal:AbortSignal})=>
 Promise<{events:AsyncIterable<ThreadEvent>}>};
type CodexFactory={startThread:(options:{
 workingDirectory:string;model?:string;sandboxMode:'read-only';
 approvalPolicy:'never';networkAccessEnabled:false;webSearchMode:'disabled';
 additionalDirectories:[];skipGitRepoCheck:false
})=>StreamSource};
const PricingSchema=z.strictObject({
 inputUsdPerMillion:z.number().finite().nonnegative(),
 outputUsdPerMillion:z.number().finite().nonnegative(),
 cachedInputUsdPerMillion:z.number().finite().nonnegative()
});
export type CodexPricing=z.input<typeof PricingSchema>;
const allowedPath=(r:AgentExecutionRequest)=>{
 // The Docker runner must mount the approved worktree READ ONLY at its canonical
 // Ubuntu path; do not accept a caller-controlled arbitrary checkout.
 const root=process.env.OMNYA_S17_APPROVED_WORKSPACE_ROOT;
 if(!root||!/^\/home\/[a-z_][a-z0-9_-]*\/\.local\/share\/omnyadesk\/s12\/projects$/.test(root))
  throw new ProviderExecutionError('PROTOCOL_VIOLATION','A trusted Ubuntu worktree root is required');
 const path=root+'/'+r.projectId+'/'+r.runId+'/workspace';
 if(r.workspacePath!==path||r.sandboxId!=='codex-'+r.runId||r.allowedTools.length!==0||r.maxSteps>32)
  throw new ProviderExecutionError('PROTOCOL_VIOLATION','Codex S17 pilot requires its own read-only sandbox and zero tools');
 return path;
};
export function assertCodexDockerSandbox(r:AgentExecutionRequest):string{
 const path=allowedPath(r);
 if(process.platform!=='linux'||!existsSync('/.dockerenv')||!existsSync(path)||
    realpathSync(path)!==resolve(path)||!existsSync(path+'/.git')||
    !readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>{
     const fields=line.split(' ');
     return fields[4]===path && fields[5]?.split(',').includes('ro');
    }))
  throw new ProviderExecutionError('PROTOCOL_VIOLATION','Codex requires a read-only mounted Ubuntu Docker worktree');
 return path;
}
type Usage={input_tokens:number;cached_input_tokens:number;output_tokens:number};
export function estimateCodexCost(usage:Usage,pricing:CodexPricing){
 const p=PricingSchema.parse(pricing);
 const u=Math.max(0,usage.input_tokens),c=Math.max(0,Math.min(u,usage.cached_input_tokens));
 return ((u-c)*p.inputUsdPerMillion+c*p.cachedInputUsdPerMillion+
    usage.output_tokens*p.outputUsdPerMillion)/1_000_000;
}
const scalarEvent=(base:Omit<Extract<AgentProviderEvent,{type:'delta'}>,'type'|'text'>,
 seq:number,txt:string):AgentProviderEvent=>
 AgentProviderEventSchema.parse({...base,sequence:seq,type:'delta',text:txt});

// This adapter cannot be invoked by HTTP or agents directly: only a trusted
// S17 runner can supply an approved read-only Docker mount and S10 lease.
export class CodexProvider implements AgentProvider{
 readonly id='codex';
 private readonly client:CodexFactory;
 private readonly pricing:CodexPricing;
 private readonly workspace:(r:AgentExecutionRequest)=>string;
 private readonly timeoutMs:number;
 constructor(input:{pricing:CodexPricing;
  workspace:(r:AgentExecutionRequest)=>string;client?:CodexFactory;timeoutMs?:number}){
  this.pricing=PricingSchema.parse(input.pricing);
  // Real SDK execution always enforces the read-only Docker mount. Only a
  // fully injected synthetic test client may replace this guard.
  this.workspace=input.client?input.workspace:assertCodexDockerSandbox;
  this.client=input.client??new Codex({config:{max_turns:1}});
  this.timeoutMs=z.number().int().min(1000).max(120000).parse(input.timeoutMs??60000);
 }
 async *stream(raw:AgentExecutionRequest,signal:AbortSignal):AsyncIterable<AgentProviderEvent>{
  const req=AgentExecutionRequestSchema.parse(raw);
  if(req.maxCostUsd===0)throw new ProviderExecutionError('QUOTA_EXCEEDED',
   'A live provider call requires an explicit nonzero estimated budget');
  const cwd=this.workspace(req);
  allowedPath(req);
  const base={schemaVersion:1 as const,providerId:this.id,projectId:req.projectId,
   taskId:req.taskId,runId:req.runId};
  let seq=0,output='',terminal=false;
  const controlled=new AbortController();
  const onAbort=()=>controlled.abort();
  signal.addEventListener('abort',onAbort,{once:true});
  if(signal.aborted)controlled.abort();
  const timer=setTimeout(()=>controlled.abort(),this.timeoutMs);
  yield {...base,sequence:++seq,type:'started',modelId:req.modelId};
  try{
   if(controlled.signal.aborted){
    yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};return;
   }
   const thread=this.client.startThread({
    model:req.modelId==='default'?undefined:req.modelId,
    workingDirectory:cwd,sandboxMode:'read-only',
    approvalPolicy:'never',networkAccessEnabled:false,webSearchMode:'disabled',
    additionalDirectories:[],skipGitRepoCheck:false
   });
   // The real upstream cost is unknown until usage is reported. All published
   // figures are estimates, not a guaranteed billing hard stop.
   const turn=await thread.runStreamed(req.prompt,{signal:controlled.signal});
   const seen=new Map<string,string>();
   let usage:Usage|null=null;
   for await(const ev of turn.events){
    if(controlled.signal.aborted)break;
    if(ev.type==='item.updated'||ev.type==='item.completed'){
     if(ev.item.type==='agent_message'){
      const old=seen.get(ev.item.id)??'',current=ev.item.text;
      if(!current.startsWith(old))throw new ProviderExecutionError('PROTOCOL_VIOLATION','Codex message was rewritten midstream');
      const fragment=current.slice(old.length);seen.set(ev.item.id,current);
      if(fragment){
       output+=fragment;
       if(output.length>65536)
        throw new ProviderExecutionError('PROTOCOL_VIOLATION','Codex output limit exceeded');
       for(let offset=0;offset<fragment.length;offset+=16384)
        yield scalarEvent({...base,sequence:0},++seq,fragment.slice(offset,offset+16384));
      }
     }
    }else if(ev.type==='turn.completed'){
     usage=ev.usage;
    }else if(ev.type==='turn.failed'){
     const reason=String(ev.error?.message??'');
     if(/usage limit|rate limit|insufficient.quota|credits exhausted/i.test(reason)){
      yield {...base,sequence:++seq,type:'failed',error:{code:'QUOTA_EXCEEDED',
       message:'Codex ChatGPT account usage limit reached; wait for reset'}};
      return;
     }
     throw new ProviderExecutionError('PROVIDER_ERROR','Codex turn failed');
    }
   }
   if(controlled.signal.aborted){
    yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};return;
   }
   if(!usage||!Number.isSafeInteger(usage.input_tokens)||!Number.isSafeInteger(usage.output_tokens))
    throw new ProviderExecutionError('PROTOCOL_VIOLATION','Codex turn had no verifiable usage');
   const estimated=estimateCodexCost(usage,this.pricing);
   if(estimated>req.maxCostUsd){
    yield {...base,sequence:++seq,type:'failed',
     error:{code:'QUOTA_EXCEEDED',message:'Estimated usage exceeded pilot budget'}};return;
   }
   terminal=true;
   yield {...base,sequence:++seq,type:'completed',
    result:{output,artifacts:[],usage:{
     inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,costUsd:estimated}}};
  }catch(error){
   if(process.env.OMNYA_S17_DIAGNOSTIC==='1'){
    const msg=error instanceof Error?error.message:'';
    const category=/permission denied|EACCES|readonly|read-only/i.test(msg)?'PERMISSIONS':
     /model.*(not found|unsupported|invalid)|unknown model/i.test(msg)?'MODEL':
     /unable to locate|ENOENT|not found/i.test(msg)?'EXECUTABLE':
     /401|unauthorized|authentication|login/i.test(msg)?'AUTH':
     /TLS|certificate|SSL/i.test(msg)?'TLS':
     /network|connection|transport|request/i.test(msg)?'NETWORK':
     /sandbox|config|approval.policy/i.test(msg)?'CONFIG':
     /Codex Exec exited/i.test(msg)?'PROCESS_EXIT':'OTHER';
    console.error('S17_SDK_FAILURE_CATEGORY='+category);
    console.error('S17_SDK_FAILURE_SUMMARY='+msg.replace(/https?:\/\/[^\s]+/g,'[URL]')
     .replace(/Bearer\s+\S+/gi,'[TOKEN]').replace(/[A-Za-z0-9_-]{30,}/g,'[REDACTED]')
     .replace(/[\r\n]+/g,' ').slice(0,360));
   }
   if(controlled.signal.aborted||signal.aborted){
    yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};return;
   }
   if(!terminal){
    yield {...base,sequence:++seq,type:'failed',
     error:{code:'PROVIDER_ERROR',message:'Codex SDK execution rejected'}};return;
   }
   throw error;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
 }
 run(request:AgentExecutionRequest,signal:AbortSignal):Promise<AgentExecutionResult>{
  return executeProvider(this,request,signal);
 }
}
