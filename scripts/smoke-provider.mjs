import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
 executeProvider,ProviderCancelledError,ProviderExecutionError,
 AgentProviderEventSchema
} from '../dist/packages/contracts/src/provider.js';
import {MockProvider} from '../dist/packages/adapters/src/mock.js';

const request=()=>({
 projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
 role:'developer',prompt:'Synthetic S16 smoke only',
 workspacePath:'/synthetic/sandbox',sandboxId:'s16-smoke',
 modelId:'mock-v1',allowedTools:[],maxSteps:5,maxCostUsd:0
});
let checks=0;
const expected=request(),events=[];
const result=await executeProvider(new MockProvider({chunks:['hello ','mock'],delayMs:2}),
 expected,new AbortController().signal,event=>{
 events.push(AgentProviderEventSchema.parse(event));
});
assert.equal(result.output,'hello mock');checks++;
assert.deepEqual(events.map(x=>x.type),['started','delta','delta','completed']);checks++;
assert.deepEqual(events.map(x=>x.sequence),[1,2,3,4]);checks++;
assert.ok(events.every(x=>x.runId===expected.runId));checks++;
assert.equal(result.usage.costUsd,0);checks++;
const ctl=new AbortController(),cancelled=[];
await assert.rejects(executeProvider(
 new MockProvider({chunks:['first','second'],delayMs:3}),request(),ctl.signal,
 e=>{cancelled.push(e.type);if(e.type==='delta')ctl.abort();}
),ProviderCancelledError);checks++;
assert.deepEqual(cancelled,['started','delta','cancelled']);checks++;
await assert.rejects(executeProvider(new MockProvider({chunks:['first'],failAtChunk:0}),
 request(),new AbortController().signal),
 e=>e instanceof ProviderExecutionError&&e.code==='MOCK_FAILURE');checks++;
await assert.rejects(executeProvider(new MockProvider({chunks:['x','y']}),
 {...request(),maxSteps:1},new AbortController().signal),
 e=>e instanceof ProviderExecutionError&&e.code==='QUOTA_EXCEEDED');checks++;
assert.equal(checks,9);
console.log('PASS: compiled S16 neutral adapter, deterministic mock streaming, cancellation, failure and budget (9/9)');
