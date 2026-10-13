import {z} from 'zod';
import {
 AgentExecutionRequestSchema,executeProvider,type AgentProvider,
 type AgentExecutionRequest,type AgentExecutionResult,type AgentProviderEvent
} from '../../contracts/src/provider.ts';

// No network, filesystem writes, subprocesses, credentials or provider SDK.
export const MockScenarioSchema=z.strictObject({
 chunks:z.array(z.string().min(1).max(16384)).min(1).max(100).optional(),
 delayMs:z.number().int().min(0).max(2000).default(0),
 failAtChunk:z.number().int().nonnegative().max(100).optional()
});
export type MockScenario=z.input<typeof MockScenarioSchema>;

function sleepOrAbort(ms:number,signal:AbortSignal):Promise<void>{
 if(signal.aborted)return Promise.reject(new Error('abort'));
 if(ms===0)return Promise.resolve();
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(abort:boolean)=>{
   if(settled)return;
   settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);
   if(abort)reject(new Error('abort'));else resolve();
  };
  const cancel=()=>finish(true);
  const timer=setTimeout(()=>finish(false),ms);
  signal.addEventListener('abort',cancel,{once:true});
  if(signal.aborted)cancel();
 });
}

export class MockProvider implements AgentProvider {
 readonly id='mock';
 private readonly scenario:z.output<typeof MockScenarioSchema>;
 constructor(scenario:MockScenario={}){
  this.scenario=MockScenarioSchema.parse(scenario);
 }
 async *stream(raw:AgentExecutionRequest,signal:AbortSignal):AsyncIterable<AgentProviderEvent>{
  const req=AgentExecutionRequestSchema.parse(raw);
  const chunks=this.scenario.chunks??['[mock '+req.role+'] ','scenario complete'];
  let seq=0;
  const base={
   schemaVersion:1 as const,providerId:this.id,
   projectId:req.projectId,taskId:req.taskId,runId:req.runId
  };
  yield {...base,sequence:++seq,type:'started',modelId:req.modelId};
  if(signal.aborted){
   yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};
   return;
  }
  let output='';
  for(let i=0;i<chunks.length;i++){
   if(signal.aborted){
    yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};
    return;
   }
   if(this.scenario.failAtChunk===i){
    yield {...base,sequence:++seq,type:'failed',
     error:{code:'MOCK_FAILURE',message:'Deterministic mock failure'}};
    return;
   }
   if(i>=req.maxSteps||output.length+chunks[i]!.length>65536){
    yield {...base,sequence:++seq,type:'failed',
     error:{code:'QUOTA_EXCEEDED',message:'Mock step/output limit reached'}};
    return;
   }
   try{await sleepOrAbort(this.scenario.delayMs,signal);}
   catch{
    yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};
    return;
   }
   if(signal.aborted){
    yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};
    return;
   }
   const text=chunks[i]!;
   output+=text;
   yield {...base,sequence:++seq,type:'delta',text};
  }
  if(signal.aborted){
   yield {...base,sequence:++seq,type:'cancelled',reason:'aborted'};
   return;
  }
  yield {...base,sequence:++seq,type:'completed',
   result:{output,artifacts:[],usage:{inputTokens:0,outputTokens:0,costUsd:0}}};
 }
 run(request:AgentExecutionRequest,signal:AbortSignal):Promise<AgentExecutionResult>{
  return executeProvider(this,request,signal);
 }
}
