import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
 CodexProvider,estimateCodexCost,assertCodexDockerSandbox
} from '../packages/adapters/src/codex.ts';
import {executeProvider,ProviderExecutionError,ProviderCancelledError}
 from '../packages/contracts/src/provider.ts';

const request=(overrides:Record<string,unknown>={})=>{
 const projectId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
 return {projectId,taskId,runId,role:'developer' as const,
  modelId:'gpt-5.6-codex',prompt:'Read the synthetic sample and summarize its purpose',
  sandboxId:'codex-'+runId,
  workspacePath:TEST_WORKTREE_ROOT+'/'+projectId+'/'+runId+'/workspace',
  allowedTools:[],maxSteps:16,maxCostUsd:0.1,...overrides};
};
const TEST_WORKTREE_ROOT='/home/omnyatest/.local/share/omnyadesk/s12/projects';
process.env.OMNYA_S17_APPROVED_WORKSPACE_ROOT=TEST_WORKTREE_ROOT;
const pricing={inputUsdPerMillion:2,outputUsdPerMillion:8,
 cachedInputUsdPerMillion:0.5};
function client(events:unknown[],capture?:(o:unknown)=>void){
 return {startThread(options:unknown){
  capture?.(options);
  return {async runStreamed(prompt:string,{signal}:{signal:AbortSignal}){
   assert.equal(typeof prompt,'string');
   return {events:(async function*(){
    for(const item of events){
     if(signal.aborted)return;
     await Promise.resolve();yield item;
    }
   })()};
  }};
 }} as never;
}
const usage={input_tokens:250,cached_input_tokens:50,output_tokens:25,
 cache_write_input_tokens:0,reasoning_output_tokens:0};
const events=[
 {type:'item.updated',item:{id:'out',type:'agent_message',text:'alpha'}},
 {type:'item.updated',item:{id:'out',type:'agent_message',text:'alpha beta'}},
 {type:'item.completed',item:{id:'out',type:'agent_message',text:'alpha beta'}},
 {type:'turn.completed',usage}
];
test('S17 Codex fake SDK validates safe defaults and real stream contract',async()=>{
 const r=request(),opts:unknown[]=[];
 const provider=new CodexProvider({pricing,workspace:()=>r.workspacePath,
  client:client(events,o=>opts.push(o))});
 const packets:string[]=[];
 const result=await executeProvider(provider,r,new AbortController().signal,
  e=>packets.push(e.type));
 assert.equal(result.output,'alpha beta');
 assert.deepEqual(packets,['started','delta','delta','completed']);
 assert.equal(result.usage.inputTokens,250);
 assert.equal(result.usage.outputTokens,25);
 assert.equal(result.usage.costUsd,estimateCodexCost(usage,pricing));
 const o=opts[0] as Record<string,unknown>;
 assert.equal(o.sandboxMode,'read-only');
 assert.equal(o.networkAccessEnabled,false);
 assert.equal(o.approvalPolicy,'never');
 assert.deepEqual(o.additionalDirectories,[]);
 assert.equal(o.workingDirectory,r.workspacePath);
});
test('S17 ChatGPT login uses account default model without forcing unsupported SKU',async()=>{
 const r=request({modelId:'default'}),seen:unknown[]=[];
 const p=new CodexProvider({pricing,workspace:()=>r.workspacePath,
  client:client(events,o=>seen.push(o))});
 assert.equal((await p.run(r,new AbortController().signal)).output,'alpha beta');
 assert.equal((seen[0] as {model?:string}).model,undefined);
});
test('S17 account rate limit is a safe QUOTA_EXCEEDED terminal failure',async()=>{
 const r=request();
 const p=new CodexProvider({pricing,workspace:()=>r.workspacePath,
  client:client([{type:'turn.failed',error:{message:'You have hit your usage limit; try later'}}])});
 await assert.rejects(p.run(r,new AbortController().signal),
  e=>e instanceof ProviderExecutionError&&e.code==='QUOTA_EXCEEDED');
});
test('S17 rejects caller-controlled workspace, scripts, tools and too many steps',async()=>{
 const r=request(),fake=client(events);
 for(const bad of [
  {...r,workspacePath:'/tmp/unsafe'},
  {...r,sandboxId:'bypass'},
  {...r,allowedTools:['shell.exec']},
  {...r,maxSteps:40}
 ]){
  const provider=new CodexProvider({pricing,workspace:()=>r.workspacePath,client:fake});
  await assert.rejects(provider.run(bad,new AbortController().signal));
 }
});
test('S17 rejects invalid usage budget, does not claim zero cost',async()=>{
 const r=request({maxCostUsd:0.00001});
 const provider=new CodexProvider({pricing,workspace:()=>r.workspacePath,client:client(events)});
 await assert.rejects(provider.run(r,new AbortController().signal),
  e=>e instanceof ProviderExecutionError&&e.code==='QUOTA_EXCEEDED');
});
test('S17 detects untrusted adapter failure instead of successful fake completion',async()=>{
 const r=request();
 for(const eventStream of [
  [...events.slice(0,3)],
  [{type:'turn.failed',error:{message:'rejected'}}],
  [{type:'item.updated',item:{id:'out',type:'agent_message',text:'one'}},
   {type:'item.updated',item:{id:'out',type:'agent_message',text:'two'}},
   {type:'turn.completed',usage}]
 ]){
  const p=new CodexProvider({pricing,workspace:()=>r.workspacePath,client:client(eventStream)});
  await assert.rejects(p.run(r,new AbortController().signal),
   e=>e instanceof ProviderExecutionError&&e.code==='PROVIDER_ERROR');
 }
});
test('S17 abort never returns completed while in flight',async()=>{
 const r=request(),ctl=new AbortController();
 const p=new CodexProvider({pricing,workspace:()=>r.workspacePath,client:client(events)});
 await assert.rejects(executeProvider(p,r,ctl.signal,e=>{
  if(e.type==='delta')ctl.abort();
 }),ProviderCancelledError);
});
test('S17 zero estimated budget refuses model call before SDK invocation',async()=>{
 const r=request({maxCostUsd:0});
 const p=new CodexProvider({pricing,workspace:()=>r.workspacePath,client:client(events)});
 await assert.rejects(p.run(r,new AbortController().signal),
  e=>e instanceof ProviderExecutionError&&e.code==='QUOTA_EXCEEDED');
});
test('S17 cost estimation counts cached input separately, rejects negative unit prices',()=>{
 assert.equal(estimateCodexCost({input_tokens:100,cached_input_tokens:20,output_tokens:10},
  {inputUsdPerMillion:10,cachedInputUsdPerMillion:2,outputUsdPerMillion:50}),
  (800+40+500)/1e6);
 assert.throws(()=>estimateCodexCost(usage,{inputUsdPerMillion:-1,
  cachedInputUsdPerMillion:0,outputUsdPerMillion:1}));
});
test('S17 requires operator-approved root and rejects untrusted override',async()=>{
 const trusted=process.env.OMNYA_S17_APPROVED_WORKSPACE_ROOT;
 const r=request();
 const p=new CodexProvider({pricing,workspace:()=>r.workspacePath,client:client(events)});
 try{
  delete process.env.OMNYA_S17_APPROVED_WORKSPACE_ROOT;
  await assert.rejects(p.run(r,new AbortController().signal));
  process.env.OMNYA_S17_APPROVED_WORKSPACE_ROOT='/tmp/untrusted';
  await assert.rejects(p.run(r,new AbortController().signal));
 }finally{process.env.OMNYA_S17_APPROVED_WORKSPACE_ROOT=trusted;}
});
test('S17 runtime guard cannot be bypassed on Windows non-Docker environment',()=>{
 const r=request();
 if(process.platform==='win32')assert.throws(()=>assertCodexDockerSandbox(r));
});
