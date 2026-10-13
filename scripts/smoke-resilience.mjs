import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {MockProvider} from '../dist/packages/adapters/src/mock.js';
import {MockResilienceController,ResilienceBlocked} from '../dist/packages/pipeline/src/resilience.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const input=()=>({
 goal:'synthetic compiled S19 smoke',actors:{
  architect:'synthetic-architect',developer:'synthetic-developer',
  qa:'synthetic-qa',reviewer:'synthetic-reviewer'
 },request:{projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
  role:'architect',prompt:'NO SECRETS - synthetic text',workspacePath:'/synthetic',
  sandboxId:'mock-s19',modelId:'mock-v1',allowedTools:[],
  maxSteps:20,maxCostUsd:0}
});
const policy=options=>({
 timeoutMs:1500,maxInputTokens:0,maxOutputTokens:0,maxDeltaSteps:16,
 maxEstimatedCostUsd:0,maxRetries:1,retryBaseMs:1,...options
});
const checks={
 qaCheck:async c=>({passed:true,examinerId:'synthetic-ci',
  examinedSha256:c.developerOutputSha256,reportSha256:hash('safe-qa'),
  source:'external_test_runner'}),
 reviewerCheck:async c=>({passed:true,examinerId:'synthetic-independent',
  examinedSha256:c.outputSha256,reportSha256:hash('safe-review'),
  source:'independent_reviewer'})
};
const run=(controller,changes={})=>controller.execute(input(),{
 provider:new MockProvider({chunks:['SAFE','-MOCK']}),signal:new AbortController().signal,
 ...checks,...changes
});
let checksPassed=0;
const {pipeline,usage}=await run(new MockResilienceController(policy()));
assert.equal(pipeline.status,'awaiting_human_approval');checksPassed++;
assert.equal(pipeline.humanApprovalRequired,true);checksPassed++;
assert.equal(pipeline.gitIntegrated,false);checksPassed++;
assert.equal(pipeline.stages.length,4);checksPassed++;
assert.equal(usage.deltaSteps,8);checksPassed++;
await assert.rejects(run(new MockResilienceController(policy({maxDeltaSteps:2}))),
 e=>e instanceof ResilienceBlocked&&e.code==='STEP_BUDGET_EXCEEDED');checksPassed++;
const dead=new MockResilienceController(policy());
dead.kill();
await assert.rejects(run(dead),e=>e instanceof ResilienceBlocked&&e.code==='KILLED');checksPassed++;
await assert.rejects(run(new MockResilienceController(policy({timeoutMs:35})),{
 provider:new MockProvider({chunks:['SLOW'],delayMs:90})}),
 e=>e instanceof ResilienceBlocked&&e.code==='TIME_BUDGET_EXCEEDED');checksPassed++;
await assert.rejects(run(new MockResilienceController(policy()),{
 qaCheck:async()=>({passed:false,examinerId:'synthetic-ci',
  examinedSha256:'a'.repeat(64),reportSha256:hash('reject'),
  source:'external_test_runner'})}));checksPassed++;
assert.equal(checksPassed,9);
console.log('PASS: compiled S19 resilience mock budgets, kill switch, timeout, QA denial and no autoapproval (9/9)');
