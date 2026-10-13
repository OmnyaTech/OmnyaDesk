import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {MockProvider} from '../packages/adapters/src/mock.ts';
import {
 executeFourRolePipeline,PipelineBlocked,STAGE_ORDER,
 type PipelineInput,type PipelineEvent,type CheckContext,type IndependentCheck
} from '../packages/pipeline/src/four-role.ts';
import type {AgentProvider,AgentExecutionRequest,AgentProviderEvent} from '../packages/contracts/src/provider.ts';
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const actors={architect:'agent-architect',developer:'agent-developer',
 qa:'agent-qa',reviewer:'agent-reviewer'};
const input=():PipelineInput=>({
 goal:'Prepare a synthetic feature and verify external QA evidence.',
 actors:{...actors},
 request:{projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
  role:'architect',prompt:'Non-sensitive synthetic request',
  workspacePath:'/tmp/synthetic',sandboxId:'synthetic-mock',modelId:'mock-v1',
  allowedTools:[],maxSteps:20,maxCostUsd:0}
});
const checks=(args:{qa?:Partial<IndependentCheck>,review?:Partial<IndependentCheck>}={})=>({
 qaCheck:async(c:CheckContext):Promise<IndependentCheck>=>({
  passed:true,examinerId:'external-ci-runner',source:'external_test_runner',
  examinedSha256:c.developerOutputSha256,reportSha256:sha('qa-report-v1'),...args.qa
 }),
 reviewerCheck:async(c:CheckContext):Promise<IndependentCheck>=>({
  passed:true,examinerId:'independent-human-reviewer-observer',
  source:'independent_reviewer',examinedSha256:c.outputSha256,
  reportSha256:sha('review-report-v1'),...args.review
 })
});
const run=(opts:Partial<Parameters<typeof executeFourRolePipeline>[1]>={},
 data:PipelineInput=input())=>executeFourRolePipeline(data,{
 provider:new MockProvider({chunks:['APPROVED: dummy output']}),
 signal:new AbortController().signal,...checks(),...opts
});

test('S18 four ordered roles produce distinct run/actor records, only awaiting human approval',async()=>{
 const e:PipelineEvent[]=[];
 const value=input();
 const out=await run({onEvent:x=>e.push(x)},value);
 assert.equal(out.status,'awaiting_human_approval');
 assert.equal(out.gitIntegrated,false);
 assert.equal(out.humanApprovalRequired,true);
 assert.equal(out.projectId,value.request.projectId);
 assert.equal(out.pipelineRunId,value.request.runId);
 assert.deepEqual(out.stages.map(s=>s.role),[...STAGE_ORDER]);
 assert.equal(new Set(out.stages.map(s=>s.runId)).size,4);
 assert.equal(new Set(out.stages.map(s=>s.actorId)).size,4);
 assert.deepEqual(e.map(x=>x.type),Array.from(STAGE_ORDER).flatMap(()=>['stage_started','stage_completed']));
 assert.match(out.chainSha256,/^[0-9a-f]{64}$/);
 assert.equal(out.estimatedTotalUsd,0);
 assert.equal(out.stages[0]?.previousChainSha256,null);
 assert.equal(out.stages[3]?.previousChainSha256,out.stages[2]?.chainSha256);
 assert.equal(out.stages[2]?.independentCheck?.source,'external_test_runner');
 assert.equal(out.stages[3]?.independentCheck?.source,'independent_reviewer');
});
test('S18 QA explicit independent test runner rejection stops before reviewer',async()=>{
 const e:PipelineEvent[]=[];
 await assert.rejects(run({...checks({qa:{passed:false}}),onEvent:x=>e.push(x)}),
  (err:unknown)=>err instanceof PipelineBlocked&&err.role==='qa'&&err.code==='INDEPENDENT_GATE_FAILED');
 assert.deepEqual(e.filter(x=>x.type==='stage_started').map(x=>x.role),['architect','developer','qa']);
 assert.equal(e.at(-1)?.type,'stage_blocked');
});
test('S18 reviewer denial never approves even when agent text falsely says APPROVED',async()=>{
 await assert.rejects(run(checks({review:{passed:false}})),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='reviewer');
});
test('S18 forbids agent to self-approve QA or reviewer',async()=>{
 for(const [which,field] of [['qa','qa'],['review','reviewer']] as const){
  const args=which==='qa'?{qa:{examinerId:actors.qa}}:{review:{examinerId:actors.reviewer}};
  await assert.rejects(run(checks(args)),
   (e:unknown)=>e instanceof PipelineBlocked&&e.role===field);
 }
});
test('S18 reviewer attestation cannot reuse the QA examiner identity',async()=>{
 await assert.rejects(run(checks({review:{examinerId:'external-ci-runner'}})),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='reviewer');
});
test('S18 forged/obsolete QA hash denied, no self certification',async()=>{
 await assert.rejects(run(checks({qa:{examinedSha256:sha('obsolete')}})),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='qa');
});
test('S18 forged reviewer hash denied and wrong provenance denied',async()=>{
 await assert.rejects(run(checks({review:{examinedSha256:sha('unrelated')}})),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='reviewer');
 await assert.rejects(run(checks({review:{source:'external_test_runner'}})),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='reviewer');
});
test('S18 four stage actor IDs must be unique, no tool authorization',async()=>{
 const a=input();a.actors.qa=a.actors.developer;
 await assert.rejects(run({},a));
 const b=input();b.request.allowedTools=['shell.exec'];
 await assert.rejects(run({},b));
 const c=input();c.request.role='reviewer';
 await assert.rejects(run({},c));
});
test('S18 pre-aborted request emits zero starts',async()=>{
 const ctl=new AbortController();ctl.abort();
 const seen:PipelineEvent[]=[];
 await assert.rejects(run({signal:ctl.signal,onEvent:e=>seen.push(e)}),
  (e:unknown)=>e instanceof PipelineBlocked&&e.code==='CANCELLED');
 assert.deepEqual(seen.map(e=>e.type),['stage_blocked']);
});
test('S18 cancellation after developer prevents QA and reviewer execution',async()=>{
 const ctl=new AbortController(),seen:PipelineEvent[]=[];
 await assert.rejects(run({signal:ctl.signal,onEvent:e=>{
  seen.push(e);if(e.type==='stage_completed'&&e.role==='developer')ctl.abort();
 }}),(e:unknown)=>e instanceof PipelineBlocked&&e.role==='qa'&&e.code==='CANCELLED');
 assert.deepEqual(seen.filter(e=>e.type==='stage_started').map(x=>x.role),['architect','developer']);
});
test('S18 provider failure at developer stage blocks downstream',async()=>{
 let step=0;
 const provider:AgentProvider={
  id:'mock',
  async *stream(r:AgentExecutionRequest,signal:AbortSignal):AsyncIterable<AgentProviderEvent>{
   step++;
   const base={providerId:'mock',schemaVersion:1 as const,
    projectId:r.projectId,taskId:r.taskId,runId:r.runId};
   yield {...base,sequence:1,type:'started',modelId:r.modelId};
   if(step===2)yield {...base,sequence:2,type:'failed',
    error:{code:'MOCK_FAILURE',message:'synthetic failure'}};
   else if(!signal.aborted){
    yield {...base,sequence:2,type:'delta',text:'ok'};
    yield {...base,sequence:3,type:'completed',
     result:{output:'ok',artifacts:[],usage:{inputTokens:0,outputTokens:0,costUsd:0}}};
   }
  },
  run:async()=>{throw Error('not called')}
 };
 await assert.rejects(run({provider}),(e:unknown)=>
  e instanceof PipelineBlocked&&e.role==='developer'&&e.code==='PROVIDER_FAILED');
 assert.equal(step,2);
});
test('S18 separate stage prompts hand off prior texts as untrusted evidence only',async()=>{
 const seen:AgentExecutionRequest[]=[];
 const base=new MockProvider({chunks:['a']});
 const provider:AgentProvider={
  id:base.id,async *stream(r,signal){
   seen.push(r);yield* base.stream(r,signal);
  },
  run:(r,signal)=>base.run(r,signal)
 };
 await run({provider});
 assert.deepEqual(seen.map(x=>x.role),[...STAGE_ORDER]);
 assert.equal(seen.every(x=>x.projectId===seen[0]?.projectId),true);
 assert.equal(seen.every(x=>x.taskId===seen[0]?.taskId),true);
 assert.equal(new Set(seen.map(x=>x.runId)).size,4);
 assert.match(seen[1]!.prompt,/PRIOR STAGE TEXT/);
 assert.match(seen[3]!.prompt,/DEVELOPER OUTPUT/);
});
test('S18 rejects huge handoff to subsequent model without truncating sensitive text',async()=>{
 const base=new MockProvider({chunks:['x'.repeat(14000)]});
 await assert.rejects(run({provider:base}),
  (e:unknown)=>e instanceof PipelineBlocked&&e.code==='BUDGET_EXCEEDED');
});
test('S18 examiner exceptions fail closed and do not run reviewer',async()=>{
 await assert.rejects(run({...checks(),qaCheck:async()=>{throw Error('independent service down')}}),
  (e:unknown)=>e instanceof PipelineBlocked&&e.role==='qa'&&e.code==='PROVIDER_FAILED');
});
test('S18 cannot report successful four-role pipeline with malformed attestation payload',async()=>{
 await assert.rejects(run({...checks(),qaCheck:async c=>({
  passed:true,examinerId:'ci-runner',source:'external_test_runner',
  examinedSha256:c.developerOutputSha256,reportSha256:'bad'
 })}), (e:unknown)=>e instanceof PipelineBlocked&&e.role==='qa');
});
