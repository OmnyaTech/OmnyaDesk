import {z} from 'zod';
import {UuidSchema} from './domain.ts';

// The provider API is independent from the Task FSM and from any vendor SDK.
// A run is not trusted to authorize filesystem operations or human decisions.
export const AgentExecutionRequestSchema=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,runId:UuidSchema,
 role:z.enum(['architect','developer','qa','reviewer']),
 prompt:z.string().min(1).max(16000),
 workspacePath:z.string().min(1).max(4096),
 sandboxId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
 modelId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),
 allowedTools:z.array(z.string().regex(/^[a-z][a-z0-9._:-]{0,79}$/)).max(32).refine(
  a=>new Set(a).size===a.length,'Duplicate tool identifiers'),
 maxSteps:z.number().int().min(1).max(100),
 maxCostUsd:z.number().finite().min(0).max(100)
});
export type AgentExecutionRequest=z.infer<typeof AgentExecutionRequestSchema>;

export const AgentExecutionResultSchema=z.strictObject({
 output:z.string().max(65536),
 artifacts:z.array(z.strictObject({
  path:z.string().min(1).max(512).refine(
   p=>!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').some(x=>x===''||x==='.'||x==='..'),
   'Artifact path must be relative without traversal'),
  sha256:z.string().regex(/^[a-f0-9]{64}$/)
 })).max(32),
 usage:z.strictObject({
  inputTokens:z.number().int().nonnegative(),
  outputTokens:z.number().int().nonnegative(),
  costUsd:z.number().finite().nonnegative()
 })
});
export type AgentExecutionResult=z.infer<typeof AgentExecutionResultSchema>;

const envelope={
 schemaVersion:z.literal(1),
 providerId:z.string().regex(/^[a-z][a-z0-9._-]{1,79}$/),
 projectId:UuidSchema,taskId:UuidSchema,runId:UuidSchema,
 sequence:z.number().int().positive()
};
export const AgentProviderEventSchema=z.discriminatedUnion('type',[
 z.strictObject({...envelope,type:z.literal('started'),modelId:z.string().min(1).max(100)}),
 z.strictObject({...envelope,type:z.literal('delta'),text:z.string().min(1).max(16384)}),
 z.strictObject({...envelope,type:z.literal('completed'),result:AgentExecutionResultSchema}),
 z.strictObject({...envelope,type:z.literal('cancelled'),reason:z.literal('aborted')}),
 z.strictObject({...envelope,type:z.literal('failed'),
  error:z.strictObject({code:z.enum(['MOCK_FAILURE','QUOTA_EXCEEDED','PROVIDER_ERROR']),
   message:z.string().min(1).max(200)})})
]);
export type AgentProviderEvent=z.infer<typeof AgentProviderEventSchema>;

export interface AgentProvider{
 readonly id:string;
 stream(request:AgentExecutionRequest,signal:AbortSignal):AsyncIterable<AgentProviderEvent>;
 run(request:AgentExecutionRequest,signal:AbortSignal):Promise<AgentExecutionResult>;
}

export class ProviderExecutionError extends Error{
 readonly code:'MOCK_FAILURE'|'QUOTA_EXCEEDED'|'PROVIDER_ERROR'|'PROTOCOL_VIOLATION';
 constructor(code:'MOCK_FAILURE'|'QUOTA_EXCEEDED'|'PROVIDER_ERROR'|'PROTOCOL_VIOLATION',
  message:string){super(message);this.name='ProviderExecutionError';this.code=code;}
}
export class ProviderCancelledError extends Error{
 constructor(){super('Provider execution cancelled');this.name='AbortError';}
}

// Shared collector for S16 mock and future S17 runtime adapters: no implicit trust in the provider.
export async function executeProvider(
 provider:AgentProvider,request:AgentExecutionRequest,signal:AbortSignal,
 onEvent?:(event:AgentProviderEvent)=>void
):Promise<AgentExecutionResult>{
 const input=AgentExecutionRequestSchema.parse(request);
 let started=false,terminal=false,expected=1,output='',steps=0;
 let completed:AgentExecutionResult|undefined;
 for await(const raw of provider.stream(input,signal)){
  const e=AgentProviderEventSchema.parse(raw);
  if(terminal||e.providerId!==provider.id||e.projectId!==input.projectId||
   e.taskId!==input.taskId||e.runId!==input.runId||e.sequence!==expected++)
   throw new ProviderExecutionError('PROTOCOL_VIOLATION','Provider event identity, order or terminal invariant violated');
  if(!started){
   if(e.type!=='started'||e.modelId!==input.modelId)
    throw new ProviderExecutionError('PROTOCOL_VIOLATION','Expected matching start event');
   started=true;onEvent?.(e);continue;
  }
  if(e.type==='started')throw new ProviderExecutionError('PROTOCOL_VIOLATION','Duplicate provider start');
  if(signal.aborted&&e.type!=='cancelled')
   throw new ProviderExecutionError('PROTOCOL_VIOLATION','Provider ignored cancellation');
  if(e.type==='delta'){
   steps++;output+=e.text;
   if(steps>input.maxSteps||output.length>65536)
    throw new ProviderExecutionError('PROTOCOL_VIOLATION','Provider exceeded output limits');
   onEvent?.(e);continue;
  }
  terminal=true;
  if(e.type==='completed'){
   if(e.result.output!==output||e.result.usage.costUsd>input.maxCostUsd)
    throw new ProviderExecutionError('PROTOCOL_VIOLATION','Provider completion does not match output or budget');
   onEvent?.(e);completed=e.result;continue;
  }
  onEvent?.(e);
  if(e.type==='cancelled')throw new ProviderCancelledError();
  throw new ProviderExecutionError(e.error.code,e.error.message);
 }
 if(completed)return completed;
 throw new ProviderExecutionError('PROTOCOL_VIOLATION',
  started?'Provider stream ended without a terminal event':'Provider stream ended without starting');
}
