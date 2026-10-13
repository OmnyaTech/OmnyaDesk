import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {CodexProvider} from './packages/adapters/src/codex.js';
import {executeFourRolePipeline} from './packages/pipeline/src/four-role.js';

// Runs exclusively inside a read-only S12 worktree Docker sandbox.
// Only content-free hashes and usage may leave via stdout; no model text.
const input=JSON.parse(readFileSync('/runtime/pilot/input.json','utf8'));
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');
const tokenController=new AbortController();
const timer=setTimeout(()=>tokenController.abort(),84000);
const physicalRun=input.request.runId;
const physicalPath=input.request.workspacePath;
const stages={},outputByRole={},eventTypesByRole={},checks={};
let receipt;
try{
 const real=new CodexProvider({
  pricing:{inputUsdPerMillion:2,outputUsdPerMillion:8,cachedInputUsdPerMillion:0.5},
  workspace:()=>{throw Error('Only native trusted Docker worktree validation allowed');},
  timeoutMs:73000
 });
 const provider={id:'codex',
  async *stream(request,signal){
   // The four logical stage run IDs never grant new OS workspaces.
   // Every real call is remapped to the same S12-approved physical worktree,
   // preserving the logical run in the verified event envelope.
   const actual={...request,runId:physicalRun,workspacePath:physicalPath,
    sandboxId:'codex-'+physicalRun};
   let message='';
   const types=[];
   for await(const event of real.stream(actual,signal)){
    types.push(event.type);
    if(event.type==='delta')message+=event.text;
    yield {...event,runId:request.runId};
   }
   outputByRole[request.role]=message;
   eventTypesByRole[request.role]=types;
  },
  async run(){throw Error('S18 pipeline must only call streaming provider');}
 };
 const verify=async(role,ctx,signal)=>{
  if(signal.aborted)throw Error('Independent verifier cancelled');
  const text=outputByRole[role==='qa'?'developer':'reviewer']??'';
  const digest=sha(text);
  const expected=role==='qa'?ctx.developerOutputSha256:ctx.outputSha256;
  if(digest!==expected)throw Error('Stage output digest mismatch at independent check');
  const actorId=role==='qa'?'external-s18-ci':'external-s18-independent-review';
  const report=execFileSync(process.execPath,['/runtime/pilot/independent-check.mjs',role],{
   input:JSON.stringify({output:text,outputSha256:expected,
    developerOutputSha256:ctx.developerOutputSha256,actorId}),
   encoding:'utf8',timeout:8000,maxBuffer:8192,windowsHide:true
  });
  const verified=JSON.parse(report);
  if(verified.passed!==true||verified.outputSha256!==expected||
     verified.examinerId!==actorId)throw Error('Independent verifier denied');
  checks[role]=verified.reportSha256;
  return {passed:true,examinerId:actorId,examinedSha256:expected,
   reportSha256:verified.reportSha256,
   source:role==='qa'?'external_test_runner':'independent_reviewer'};
 };
 const result=await executeFourRolePipeline(input,{
  provider,signal:tokenController.signal,
  qaCheck:(ctx,signal)=>verify('qa',ctx,signal),
  reviewerCheck:(ctx,signal)=>verify('reviewer',ctx,signal),
  onEvent:e=>{
   if(e.type==='stage_started')stages[e.role]={logicalRunId:e.runId,started:true};
   if(e.type==='stage_completed')stages[e.role].receipt=e.receipt;
   if(e.type==='stage_blocked')stages[e.role].blocked=e.code;
  }
 });
 if(tokenController.signal.aborted)throw Error('S18 global deadline exceeded');
 if(result.gitIntegrated!==false||result.humanApprovalRequired!==true||
    result.status!=='awaiting_human_approval')throw Error('S15 approval boundary violated');
 const expectedRoles=['architect','developer','qa','reviewer'];
 if(JSON.stringify(result.stages.map(s=>s.role))!==JSON.stringify(expectedRoles))
  throw Error('Incorrect real provider stage order');
 if(!result.stages.every(s=>s.inputTokens>0&&s.outputTokens>0&&
    s.estimatedCostUsd>0))throw Error('Missing real stage usage');
 if(result.estimatedTotalUsd>input.request.maxCostUsd)throw Error('S18 estimated run budget breached');
 receipt={status:'completed',projectId:result.projectId,taskId:result.taskId,
  physicalRunId:physicalRun,pipelineRunId:result.pipelineRunId,
  stageReceipts:result.stages,modelEvents:eventTypesByRole,
  checkDigests:checks,chainSha256:result.chainSha256,
  estimatedTotalUsd:result.estimatedTotalUsd,
  statusCode:result.status,gitIntegrated:result.gitIntegrated,
  humanApprovalRequired:result.humanApprovalRequired};
}catch(err){
 receipt={status:'failed',physicalRunId:physicalRun,
  stageStates:Object.fromEntries(Object.entries(stages).map(([r,v])=>[r,
   {started:v.started===true,blocked:v.blocked??null}])),
  // No raw external output, user text or credentials in telemetry.
  errorType:err?.name??'Unknown',
  errorCategory:tokenController.signal.aborted?'TIMEOUT':'PIPELINE_ERROR'};
 process.exitCode=1;
}finally{clearTimeout(timer);}
console.log('S18_LIVE_RECEIPT='+JSON.stringify(receipt));
