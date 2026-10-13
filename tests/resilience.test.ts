import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MockProvider} from '../packages/adapters/src/mock.ts';
import {
 MockResilienceController,ResilienceBlocked,ResiliencePolicySchema,
 type ResiliencePolicy,type ResilienceEvent
} from '../packages/pipeline/src/resilience.ts';
import {PipelineBlocked,type PipelineInput,type CheckContext,type IndependentCheck,
 type PipelineEvent} from '../packages/pipeline/src/four-role.ts';
import type {AgentProvider,AgentProviderEvent} from '../packages/contracts/src/provider.ts';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const input=(changes:Record<string,unknown>={}):PipelineInput=>({
 goal:'Safe synthetic mock plan',actors:{
  architect:'agent-architect',developer:'agent-developer',
  qa:'agent-qa',reviewer:'agent-reviewer'},
 request:{projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
  role:'architect',prompt:'Synthetic request only',workspacePath:'/tmp/fake-repo',
  sandboxId:'mock-s19',modelId:'mock-v1',allowedTools:[],maxSteps:25,
  maxCostUsd:1,...changes}
});
const policy=(opts:Partial<ResiliencePolicy>={}):ResiliencePolicy=>({
 timeoutMs:2000,maxInputTokens:1000,maxOutputTokens:1000,
 maxDeltaSteps:100,maxEstimatedCostUsd:1,maxRetries:2,retryBaseMs:1,...opts
});
const checks={
 qaCheck:async(c:CheckContext):Promise<IndependentCheck>=>({
  passed:true,examinerId:'synthetic-ci',examinedSha256:c.developerOutputSha256,
  reportSha256:sha('qa-pass'),source:'external_test_runner'}),
 reviewerCheck:async(c:CheckContext):Promise<IndependentCheck>=>({
  passed:true,examinerId:'synthetic-review',examinedSha256:c.outputSha256,
  reportSha256:sha('review-pass'),source:'independent_reviewer'})
};
const run=(ctrl:MockResilienceController,options:{
 provider?:AgentProvider;signal?:AbortSignal;onEvent?:(e:PipelineEvent)=>void;
 onControlEvent?:(e:ResilienceEvent)=>void;
 qaCheck?:typeof checks.qaCheck;reviewerCheck?:typeof checks.reviewerCheck
}={},data:PipelineInput=input())=>ctrl.execute(data,{
 ...checks,provider:new MockProvider({chunks:['SAFE','-OUTPUT']}),
 signal:new AbortController().signal,...options
});
const fake=(transform:(events:AgentProviderEvent[],attempt:number)=>AgentProviderEvent[]):AgentProvider=>{
 const base=new MockProvider({chunks:['SAFE','-OUTPUT']});
 let calls=0;
 return {id:'mock',
  async *stream(request,signal){
   calls++;
   const events:AgentProviderEvent[]=[];
   for await(const event of base.stream(request,signal))events.push(event);
   for(const event of transform(events,calls))yield event;
  },
  run:()=>Promise.reject(Error('unused'))
 };
};
const failedBeforeDelta=(events:AgentProviderEvent[],code:'PROVIDER_ERROR'|'QUOTA_EXCEEDED')=>{
 const started=events[0]!;
 const {providerId,schemaVersion,projectId,taskId,runId}=started;
 return [started,{providerId,schemaVersion,projectId,taskId,runId,
  type:'failed' as const,sequence:2,error:{code,message:'Synthetic transient failure'}}];
};
const failedAfterDelta=(events:AgentProviderEvent[])=>{
 const started=events[0]!;
 const {providerId,schemaVersion,projectId,taskId,runId}=started;
 return [started,events[1]!,{providerId,schemaVersion,projectId,taskId,runId,
  type:'failed' as const,sequence:3,
  error:{code:'PROVIDER_ERROR' as const,message:'Synthetic failure after output'}}];
};
const withUsage=(event:AgentProviderEvent,inputTokens:number,outputTokens:number,costUsd:number)=>
 event.type==='completed'?{...event,result:{...event.result,
  usage:{inputTokens,outputTokens,costUsd}}}:event;

test('S19 policy rejects malformed and unsafe global budgets',()=>{
 const good=policy();assert.deepEqual(ResiliencePolicySchema.parse(good),good);
 for(const bad of [{...good,timeoutMs:0},{...good,maxRetries:40},
  {...good,maxDeltaSteps:0},{...good,retryBaseMs:-1},
  {...good,maxOutputTokens:-1},{...good,maxEstimatedCostUsd:Infinity},
  {...good,arbitrary:'unknown'}]){
  assert.equal(ResiliencePolicySchema.safeParse(bad).success,false);
 }
});
test('S19 four roles succeed with global counters and human-approval lock',async()=>{
 const ctl=new MockResilienceController(policy());
 const {pipeline,usage}=await run(ctl);
 assert.equal(pipeline.status,'awaiting_human_approval');
 assert.equal(pipeline.gitIntegrated,false);
 assert.equal(pipeline.humanApprovalRequired,true);
 assert.deepEqual(pipeline.stages.map(x=>x.role),['architect','developer','qa','reviewer']);
 assert.equal(usage.providerAttempts,4);
 assert.equal(usage.retries,0);assert.equal(usage.deltaSteps,8);
 assert.equal(usage.inputTokens,0);assert.equal(usage.outputTokens,0);
 assert.match(pipeline.chainSha256,/^[a-f0-9]{64}$/);
});
test('S19 transient provider fails before stream then retries that stage only',async()=>{
 let calls=0;const e:ResilienceEvent[]=[];
 const provider=fake((events)=>{calls++;return calls===1?
  failedBeforeDelta(events,'PROVIDER_ERROR'):events;});
 const {pipeline,usage}=await run(new MockResilienceController(policy()),
  {provider,onControlEvent:v=>e.push(v)});
 assert.equal(pipeline.stages.length,4);
 assert.equal(calls,5);assert.equal(usage.retries,1);
 assert.equal(usage.providerAttempts,5);
 assert.deepEqual(e.filter(x=>x.type==='retry_scheduled').map(x=>x.type),['retry_scheduled']);
});
test('S19 bounded retries fail closed with no downstream execution',async()=>{
 let calls=0;
 const provider=fake(events=>{calls++;return failedBeforeDelta(events,'PROVIDER_ERROR');});
 const started:string[]=[];
 await assert.rejects(run(new MockResilienceController(policy({maxRetries:2})),
  {provider,onEvent:e=>{if(e.type==='stage_started')started.push(e.role);}}),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='architect');
 assert.equal(calls,3);assert.deepEqual(started,['architect']);
});
test('S19 quota failures do not retry even before first delta',async()=>{
 let calls=0;
 const provider=fake(events=>{calls++;return failedBeforeDelta(events,'QUOTA_EXCEEDED');});
 await assert.rejects(run(new MockResilienceController(policy()),{provider}),PipelineBlocked);
 assert.equal(calls,1);
});
test('S19 no retry after any partial streamed output',async()=>{
 let calls=0;
 const provider=fake(events=>{calls++;return failedAfterDelta(events);});
 await assert.rejects(run(new MockResilienceController(policy()),{provider}),PipelineBlocked);
 assert.equal(calls,1);
});
test('S19 global step cap cannot be bypassed by splitting four roles',async()=>{
 const events:ResilienceEvent[]=[];
 const ctl=new MockResilienceController(policy({maxDeltaSteps:3}));
 await assert.rejects(run(ctl,{onControlEvent:e=>events.push(e)}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='STEP_BUDGET_EXCEEDED');
 assert.ok(events.some(x=>x.type==='budget_blocked'&&x.limit==='delta_steps'));
});
test('S19 global input token budget cannot be bypassed by per-stage compliance',async()=>{
 const p=fake(events=>events.map(e=>withUsage(e,8,2,0)));
 const ctl=new MockResilienceController(policy({maxInputTokens:20}));
 await assert.rejects(run(ctl,{provider:p}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TOKEN_BUDGET_EXCEEDED');
});
test('S19 global output token budget refuses next stage',async()=>{
 const p=fake(events=>events.map(e=>withUsage(e,1,8,0)));
 await assert.rejects(run(new MockResilienceController(policy({maxOutputTokens:20})),{provider:p}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TOKEN_BUDGET_EXCEEDED');
});
test('S19 cumulative monetary estimate is budgeted, not advertised as billing cap',async()=>{
 const p=fake(events=>events.map(e=>withUsage(e,1,1,0.04)));
 await assert.rejects(run(new MockResilienceController(policy({maxEstimatedCostUsd:0.1})),{provider:p}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TOKEN_BUDGET_EXCEEDED');
});
test('S19 deadline aborts slow provider, no downstream execution',async()=>{
 const p=new MockProvider({chunks:['slow'],delayMs:200});
 const start=Date.now(),events:PipelineEvent[]=[];
 await assert.rejects(run(new MockResilienceController(policy({timeoutMs:45})),
  {provider:p,onEvent:e=>events.push(e)}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TIME_BUDGET_EXCEEDED');
 assert.ok(Date.now()-start<500);
 assert.deepEqual(events.filter(x=>x.type==='stage_started').map(x=>x.role),['architect']);
});
test('S19 kill switch aborts in flight, never restarts or approves',async()=>{
 const ctl=new MockResilienceController(policy({timeoutMs:2000}));
 const controller=new AbortController(),events:PipelineEvent[]=[];
 const promise=run(ctl,{provider:new MockProvider({chunks:['first','second'],delayMs:50}),
  signal:controller.signal,onEvent:e=>events.push(e)});
 setTimeout(()=>ctl.kill(),25);
 await assert.rejects(promise,
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='KILLED');
 assert.equal(ctl.isKilled,true);
 await assert.rejects(run(ctl),(e:unknown)=>e instanceof ResilienceBlocked&&e.code==='KILLED');
 assert.equal(events.some(e=>e.type==='stage_completed'&&e.role==='reviewer'),false);
});
test('S19 parent cancellation during exponential backoff aborts promptly',async()=>{
 const ctl=new MockResilienceController(policy({retryBaseMs:250,timeoutMs:1500}));
 const abort=new AbortController(),notices:ResilienceEvent[]=[];
 const provider=fake(events=>failedBeforeDelta(events,'PROVIDER_ERROR'));
 const started=Date.now();
 const pending=run(ctl,{provider,signal:abort.signal,onControlEvent:e=>{
  notices.push(e);if(e.type==='retry_scheduled')abort.abort();
 }});
 await assert.rejects(pending,(e:unknown)=>e instanceof ResilienceBlocked&&e.code==='KILLED');
 assert.ok(Date.now()-started<300);
 assert.ok(notices.some(x=>x.type==='retry_scheduled'));
});
test('S19 noncooperative provider promise cannot stall emergency kill',async()=>{
 const never:AgentProvider={id:'mock',
  async *stream(r){
   yield {schemaVersion:1,providerId:'mock',projectId:r.projectId,taskId:r.taskId,
    runId:r.runId,sequence:1,type:'started',modelId:r.modelId};
   await new Promise<void>(()=>{});
  },
  run:()=>Promise.reject(Error('unused'))};
 const ctl=new MockResilienceController(policy({timeoutMs:65}));
 const started=Date.now();
 await assert.rejects(run(ctl,{provider:never}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TIME_BUDGET_EXCEEDED');
 assert.ok(Date.now()-started<400);
});
test('S19 independent QA hanging without honoring AbortSignal cannot stall kill',async()=>{
 const ctl=new MockResilienceController(policy({timeoutMs:70}));
 const started=Date.now();
 await assert.rejects(run(ctl,{qaCheck:async()=>new Promise<IndependentCheck>(()=>{})}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TIME_BUDGET_EXCEEDED');
 assert.ok(Date.now()-started<400);
});
test('S19 malformed provider identity fails closed without retry',async()=>{
 let calls=0;
 const p=fake(events=>{calls++;return events.map(e=>e.type==='delta'?
  {...e,runId:randomUUID()}:e);});
 await assert.rejects(run(new MockResilienceController(policy()),{provider:p}),PipelineBlocked);
 assert.equal(calls,1);
});
test('S19 an attempted real provider is blocked while S17 validation is pending',async()=>{
 const base=new MockProvider();
 const unsafe:AgentProvider={...base,id:'codex',
  stream:(r,s)=>base.stream(r,s),run:(r,s)=>base.run(r,s)};
 await assert.rejects(run(new MockResilienceController(policy()),{provider:unsafe}),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='PIPELINE_FAILED');
});
test('S19 isolated parallel runs do not share budget, halt status or identities',async()=>{
 const a=new MockResilienceController(policy()),b=new MockResilienceController(policy());
 const [x,y]=await Promise.all([run(a),run(b)]);
 assert.notEqual(x.pipeline.pipelineRunId,y.pipeline.pipelineRunId);
 assert.equal(x.usage.deltaSteps,8);assert.equal(y.usage.deltaSteps,8);
 a.kill();
 assert.equal(b.isKilled,false);
 assert.equal((await run(b)).pipeline.status,'awaiting_human_approval');
});
test('S19 disposable Git main and committed content never change on failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s19-git-safe-'));
 try{
  execFileSync('git',['init','-b','main',dir],{stdio:'ignore'});
  execFileSync('git',['-C',dir,'config','user.name','Synthetic S19']);
  execFileSync('git',['-C',dir,'config','user.email','synthetic@example.invalid']);
  mkdirSync(join(dir,'feature'));writeFileSync(join(dir,'feature','SAFE.txt'),'DO NOT ALTER MAIN\n');
  execFileSync('git',['-C',dir,'add','.']);
  execFileSync('git',['-C',dir,'commit','-m','baseline'],{stdio:'ignore'});
  const head=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const base=readFileSync(join(dir,'feature','SAFE.txt'),'utf8');
  const ctrl=new MockResilienceController(policy({maxDeltaSteps:1}));
  await assert.rejects(run(ctrl,{},input({workspacePath:dir})),ResilienceBlocked);
  assert.equal(execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),head);
  assert.equal(execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
  assert.equal(readFileSync(join(dir,'feature','SAFE.txt'),'utf8'),base);
 }finally{rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
});

test('S19 broken telemetry observer cannot prevent emergency kill',async()=>{
 const ctl=new MockResilienceController(policy({timeoutMs:1200}));
 const pending=run(ctl,{provider:new MockProvider({chunks:['late'],delayMs:200}),
  onControlEvent:()=>{throw Error('untrusted observer failure');}});
 setTimeout(()=>ctl.kill(),20);
 await assert.rejects(pending,
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='KILLED');
 assert.equal(ctl.isKilled,true);
});
test('S19 broken telemetry observer cannot suppress enforced deadline or budget',async()=>{
 await assert.rejects(
  run(new MockResilienceController(policy({timeoutMs:42})),{
   provider:new MockProvider({chunks:['slow'],delayMs:140}),
   onControlEvent:()=>{throw Error('monitoring unavailable');}
  }),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='TIME_BUDGET_EXCEEDED');
 await assert.rejects(
  run(new MockResilienceController(policy({maxDeltaSteps:1})),{
   onControlEvent:()=>{throw Error('monitoring unavailable');}
  }),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='STEP_BUDGET_EXCEEDED');
});

test('S19 isolated Codex mode requires real pinned Linux Docker and zero retries',()=>{
 const input=policy({maxRetries:0});
 assert.throws(()=>new MockResilienceController(input,'isolated-codex'),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='PIPELINE_FAILED');
 assert.throws(()=>new MockResilienceController(policy({maxRetries:1}),'isolated-codex'),
  (e:unknown)=>e instanceof ResilienceBlocked&&e.code==='PIPELINE_FAILED');
});
