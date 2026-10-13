import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {executeFourRolePipeline,PipelineBlocked} from '../dist/packages/pipeline/src/four-role.js';
import {MockProvider} from '../dist/packages/adapters/src/mock.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
const projectId=randomUUID(),taskId=randomUUID(),pipelineRunId=randomUUID();
const fixture={goal:'S18 synthetic feature handoffs only',
 actors:{architect:'pilot-architect',developer:'pilot-developer',
  qa:'pilot-qa',reviewer:'pilot-reviewer'},
 request:{projectId,taskId,runId:pipelineRunId,role:'architect',
  prompt:'Non-sensitive dummy feature',workspacePath:'/tmp/nowhere',
  sandboxId:'s18-mock',modelId:'mock-v1',allowedTools:[],maxSteps:12,maxCostUsd:0}
};
const events=[];
const deps={
 provider:new MockProvider({chunks:['simulated independent output'],delayMs:0}),
 signal:new AbortController().signal,
 qaCheck:async c=>({passed:true,examinerId:'outside-ci-runner',
  examinedSha256:c.developerOutputSha256,reportSha256:sha('real external CI receipt placeholder'),
  source:'external_test_runner'}),
 reviewerCheck:async c=>({passed:true,examinerId:'outside-reviewer',
  examinedSha256:c.outputSha256,reportSha256:sha('real human reviewer receipt placeholder'),
  source:'independent_reviewer'}),
 onEvent:e=>events.push(e)
};
const result=await executeFourRolePipeline(fixture,deps);
assert.deepEqual(result.stages.map(s=>s.role),['architect','developer','qa','reviewer']);
assert.equal(result.humanApprovalRequired,true);
assert.equal(result.gitIntegrated,false);
assert.equal(result.status,'awaiting_human_approval');
assert.equal(result.stages.length,4);
assert.equal(events.length,8);
assert.equal(result.estimatedTotalUsd,0);
for(const r of result.stages)assert.match(r.chainSha256,/^[a-f0-9]{64}$/);
await assert.rejects(executeFourRolePipeline(fixture,{
 ...deps,qaCheck:async c=>({...await deps.qaCheck(c),passed:false})
}),e=>e instanceof PipelineBlocked&&e.role==='qa');
console.log('PASS: compiled S18 four role pipeline, external QA/reviewer attestation and human approval lock (10/10)');
