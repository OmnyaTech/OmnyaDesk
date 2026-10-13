import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {
 AgentExecutionRequestSchema,AgentProviderEventSchema,executeProvider,
 ProviderExecutionError,ProviderCancelledError,
 type AgentExecutionRequest,type AgentProvider,type AgentProviderEvent
} from '../packages/contracts/src/provider.ts';
import {MockProvider,MockScenarioSchema} from '../packages/adapters/src/mock.ts';

const request=(other:Partial<AgentExecutionRequest>={}):AgentExecutionRequest=>({
 projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
 role:'developer',prompt:'synthetic prompt, never echo credentials',
 workspacePath:'/sandbox/worktree',sandboxId:'test-sandbox',modelId:'mock-v1',
 allowedTools:[],maxSteps:8,maxCostUsd:0,...other
});
const stream=async(p:AgentProvider,r:AgentExecutionRequest,signal:AbortSignal)=>{
 const events:AgentProviderEvent[]=[];
 for await(const event of p.stream(r,signal))events.push(AgentProviderEventSchema.parse(event));
 return events;
};

test('S16 request contract rejects unknown fields, invalid identifiers, limits and tool escalation',()=>{
 const valid=request();
 assert.deepEqual(AgentExecutionRequestSchema.parse(valid),valid);
 for(const bad of [
  {...valid,projectId:'not-uuid'},
  {...valid,runId:'not-a-run'}, {...valid,role:'system'},
  {...valid,prompt:''},{...valid,prompt:'x'.repeat(16001)},
  {...valid,allowedTools:['shell','shell']},
  {...valid,allowedTools:['rm -rf /']},
  {...valid,maxSteps:0},{...valid,maxSteps:101},
  {...valid,maxCostUsd:-1},{...valid,maxCostUsd:Infinity},
  {...valid,apiKey:'secret'},
  {...valid,sandboxId:'../outside'}
 ])assert.equal(AgentExecutionRequestSchema.safeParse(bad).success,false,JSON.stringify(bad).slice(0,100));
 assert.equal(MockScenarioSchema.safeParse({chunks:[]}).success,false);
 assert.equal(MockScenarioSchema.safeParse({delayMs:-1}).success,false);
 assert.equal(MockScenarioSchema.safeParse({chunks:['ok'],unexpected:'hook'}).success,false);
});

test('S16 mock streams deterministic bounded events then one completion, matching run result',async()=>{
 const p=new MockProvider({chunks:['stage-1 ','stage-2'],delayMs:0});
 const r=request(),abort=new AbortController(),events=await stream(p,r,abort.signal);
 assert.deepEqual(events.map(e=>e.type),['started','delta','delta','completed']);
 assert.deepEqual(events.map(e=>e.sequence),[1,2,3,4]);
 assert.ok(events.every(e=>e.runId===r.runId&&e.projectId===r.projectId&&e.taskId===r.taskId));
 const result=await executeProvider(p,r,abort.signal);
 assert.equal(result.output,'stage-1 stage-2');
 assert.deepEqual(result.artifacts,[]);
 assert.deepEqual(result.usage,{inputTokens:0,outputTokens:0,costUsd:0});
 assert.deepEqual(await p.run(r,abort.signal),result);
 assert.equal(events.find(e=>e.type==='completed')?.type,'completed');
 assert.ok(!events.some(e=>JSON.stringify(e).includes(r.prompt)));
});

test('S16 pre-aborted stream produces start and terminal cancellation, no deltas',async()=>{
 const controller=new AbortController();controller.abort();
 const p=new MockProvider({chunks:['secret']});
 const events=await stream(p,request(),controller.signal);
 assert.deepEqual(events.map(e=>e.type),['started','cancelled']);
 await assert.rejects(p.run(request(),controller.signal),ProviderCancelledError);
});

test('S16 cancellation after first delta stops all output and does not report success',async()=>{
 const p=new MockProvider({chunks:['one','two','three']});
 const ctl=new AbortController(),r=request();
 const seen:AgentProviderEvent[]=[];
 for await(const e of p.stream(r,ctl.signal)){
  seen.push(e);
  if(e.type==='delta')ctl.abort();
 }
 assert.deepEqual(seen.map(e=>e.type),['started','delta','cancelled']);
 assert.equal(seen.filter(e=>e.type==='completed').length,0);
 const ctl2=new AbortController();
 await assert.rejects(executeProvider(p,r,ctl2.signal,e=>{
  if(e.type==='delta')ctl2.abort();
 }),ProviderCancelledError);
});

test('S16 AbortSignal interrupts pending delay promptly and frees the wait',async()=>{
 const p=new MockProvider({chunks:['late'],delayMs:1000});
 const ctl=new AbortController();
 const r=request(),start=Date.now();
 const iterator=p.stream(r,ctl.signal)[Symbol.asyncIterator]();
 assert.equal((await iterator.next()).value?.type,'started');
 const pending=iterator.next(); // timer is abortable; cancellation is not a timeout failure
 ctl.abort();
 const terminal=await pending;
 assert.equal(terminal.value?.type,'cancelled');
 assert.equal((await iterator.next()).done,true);
 assert.ok(Date.now()-start<450,'abort failed to interrupt timer promptly');
});

test('S16 explicit injected failure before/after delta is a failure, never completed',async()=>{
 const r=request();
 const failure0=await stream(new MockProvider({chunks:['a'],failAtChunk:0}),r,new AbortController().signal);
 assert.deepEqual(failure0.map(e=>e.type),['started','failed']);
 const provider=new MockProvider({chunks:['public','more'],failAtChunk:1});
 const ev=await stream(provider,r,new AbortController().signal);
 assert.deepEqual(ev.map(e=>e.type),['started','delta','failed']);
 assert.equal(ev.at(-1)?.type,'failed');
 await assert.rejects(provider.run(r,new AbortController().signal),
  (e:unknown)=>e instanceof ProviderExecutionError&&e.code==='MOCK_FAILURE');
});

test('S16 mock fails closed when requested step budget is insufficient',async()=>{
 const r=request({maxSteps:1});
 const provider=new MockProvider({chunks:['first','second']});
 const events=await stream(provider,r,new AbortController().signal);
 assert.deepEqual(events.map(e=>e.type),['started','delta','failed']);
 await assert.rejects(provider.run(r,new AbortController().signal),
  (e:unknown)=>e instanceof ProviderExecutionError&&e.code==='QUOTA_EXCEEDED');
});

test('S16 two simultaneous runs remain isolated, no run ID or stream leakage',async()=>{
 const p=new MockProvider({chunks:['shared-mock','-only'],delayMs:3});
 const a=request(),b=request();
 const [x,y]=await Promise.all([stream(p,a,new AbortController().signal),
  stream(p,b,new AbortController().signal)]);
 assert.notEqual(a.runId,b.runId);
 assert.ok(x.every(e=>e.runId===a.runId));
 assert.ok(y.every(e=>e.runId===b.runId));
 assert.deepEqual(x.map(e=>e.type),y.map(e=>e.type));
});

test('S16 collector rejects malicious or broken adapter protocol identities and ordering',async()=>{
 const r=request(),p=new MockProvider({chunks:['ok']});
 const good=await stream(p,r,new AbortController().signal);
 const mutate=[
  [{...good[0],sequence:2},...good.slice(1)],
  [good[0],{...good[1],runId:randomUUID()},...good.slice(2)],
  [good[0],{...good[1],text:'not matching'},...good.slice(2)],
  [good[0],good[1]],
  [good[0],good[1],good[2],{...good[2],sequence:4}],
  [good[0],good[1],good[2],{...good[1],sequence:4}],
  []
 ];
 for(const events of mutate){
  const fake:AgentProvider={id:'mock',
   async *stream(){for(const e of events)yield e as AgentProviderEvent;},
   run(){throw new Error('not called');}};
  await assert.rejects(executeProvider(fake,r,new AbortController().signal),
   (e:unknown)=>e instanceof Error);
 }
});

test('S16 public adapter rejects invalid output artifacts, malformed event envelopes',()=>{
 const r=request();
 const base={schemaVersion:1,providerId:'mock',projectId:r.projectId,taskId:r.taskId,
  runId:r.runId,sequence:1,type:'delta',text:'ok'};
 for(const bad of [
  {...base,unexpected:'API_TOKEN'},
  {...base,sequence:0},
  {...base,text:''},
  {...base,runId:123},
  {...base,type:'unknown'},
  {...base,type:'completed',result:{output:'x',artifacts:[{path:'../private.env',sha256:'a'.repeat(64)}],
   usage:{inputTokens:0,outputTokens:0,costUsd:0}}}
 ])assert.equal(AgentProviderEventSchema.safeParse(bad).success,false);
});

test('S16 consumer callback sees streaming events in order without side effects',async()=>{
 const p=new MockProvider({chunks:['a','b','c']});
 const r=request(),seq:number[]=[];
 const result=await executeProvider(p,r,new AbortController().signal,e=>seq.push(e.sequence));
 assert.deepEqual(seq,[1,2,3,4,5]);
 assert.equal(result.output,'abc');
});
