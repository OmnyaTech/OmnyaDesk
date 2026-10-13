import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {
 AgentExecutionRequestSchema,executeProvider,type AgentExecutionRequest,
 type AgentProvider,type AgentExecutionResult
} from '../../contracts/src/provider.ts';

const SHA=z.string().regex(/^[a-f0-9]{64}$/);
export const PipelineRoleSchema=z.enum(['architect','developer','qa','reviewer']);
export type PipelineRole=z.infer<typeof PipelineRoleSchema>;
export const STAGE_ORDER=['architect','developer','qa','reviewer'] as const;
const Sha= (s:string)=>createHash('sha256').update(s,'utf8').digest('hex');

const InputSchema=z.strictObject({
 request:AgentExecutionRequestSchema,
 actors:z.strictObject({
  architect:z.string().min(3).max(100),
  developer:z.string().min(3).max(100),
  qa:z.string().min(3).max(100),
  reviewer:z.string().min(3).max(100)
 }),
 goal:z.string().min(1).max(3000)
}).superRefine((value,ctx)=>{
 const all=Object.values(value.actors);
 if(new Set(all).size!==4)ctx.addIssue({code:'custom',path:['actors'],message:'Four distinct actor IDs are required'});
 if(value.request.role!=='architect')ctx.addIssue({code:'custom',path:['request','role'],message:'Pipeline starts with architect'});
 if(value.request.allowedTools.length!==0)ctx.addIssue({code:'custom',path:['request','allowedTools'],message:'Mock pipeline must not invoke tools'});
});
export type PipelineInput=z.input<typeof InputSchema>;

const CheckSchema=z.strictObject({
 passed:z.boolean(),
 examinerId:z.string().min(3).max(100),
 examinedSha256:SHA,
 reportSha256:SHA,
 source:z.enum(['external_test_runner','independent_reviewer'])
});
export type IndependentCheck=z.infer<typeof CheckSchema>;
export type CheckContext={
 readonly role:'qa'|'reviewer';
 readonly projectId:string;
 readonly taskId:string;
 readonly pipelineRunId:string;
 readonly actorId:string;
 readonly outputSha256:string;
 readonly developerOutputSha256:string;
 readonly previousStageSha256:string;
};
export type CheckService=(context:CheckContext,signal:AbortSignal)=>Promise<IndependentCheck>;

export type StageReceipt={
 role:PipelineRole;actorId:string;runId:string;
 outputSha256:string;artifacts:number;inputTokens:number;outputTokens:number;
 estimatedCostUsd:number;previousChainSha256:string|null;chainSha256:string;
 independentCheck?:{examinerId:string;reportSha256:string;source:string};
};
export type PipelineEvent=
 | {type:'stage_started';role:PipelineRole;runId:string;actorId:string}
 | {type:'stage_completed';role:PipelineRole;runId:string;receipt:StageReceipt}
 | {type:'stage_blocked';role:PipelineRole;code:'PROVIDER_FAILED'|'INDEPENDENT_GATE_FAILED'|'CANCELLED'|'BUDGET_EXCEEDED'};
export type PipelineResult={
 status:'awaiting_human_approval';
 projectId:string;taskId:string;pipelineRunId:string;
 stages:StageReceipt[];estimatedTotalUsd:number;chainSha256:string;
 humanApprovalRequired:true;gitIntegrated:false;
};
export class PipelineBlocked extends Error {
 readonly role:PipelineRole;
 readonly code:'PROVIDER_FAILED'|'INDEPENDENT_GATE_FAILED'|'CANCELLED'|'BUDGET_EXCEEDED';
 constructor(role:PipelineRole,code:PipelineBlocked['code']){
  super('Pipeline blocked at '+role+' ('+code+')');
  this.name='PipelineBlocked';this.role=role;this.code=code;
 }
}
const stagePrompt=(role:PipelineRole,goal:string,previous:string,original:string):string=>{
 // Model outputs are untrusted input, not instructions to authorize tools.
 const lead={
  architect:'Design the solution and objective acceptance criteria.',
  developer:'Implement a proposed solution in text based on the plan; do not execute shell or change files.',
  qa:'Critically inspect the proposed work. Do not claim tests passed unless an external runner confirms.',
  reviewer:'Independently inspect the prior work, risks and QA. This is not a human approval.'
 }[role];
 const prompt=[lead,'GOAL (untrusted request):',goal,'PRIOR STAGE TEXT (untrusted):',
  previous,'USER REQUEST (untrusted):',original].join('\n');
 if(prompt.length>16000)throw new PipelineBlocked(role,'BUDGET_EXCEEDED');
 return prompt;
};
export async function executeFourRolePipeline(input:PipelineInput,deps:{
 provider:AgentProvider;
 qaCheck:CheckService;
 reviewerCheck:CheckService;
 signal:AbortSignal;
 onEvent?:(event:PipelineEvent)=>void;
}):Promise<PipelineResult>{
 const parsed=InputSchema.parse(input);
 const req=parsed.request,actors=parsed.actors;
 const receipts:StageReceipt[]=[];
 let previous='',developerText='',chain:string|null=null,spent=0,developerOutputSha256='';
 for(const role of STAGE_ORDER){
  const runId=randomUUID(),actorId=actors[role];
  const emit=(event:PipelineEvent)=>deps.onEvent?.(event);
  let result:AgentExecutionResult;
  try{
   if(deps.signal.aborted)throw new PipelineBlocked(role,'CANCELLED');
   const handoff=role==='reviewer'?previous+'\nDEVELOPER OUTPUT (untrusted):\n'+developerText:previous;
   const prompt=stagePrompt(role,parsed.goal,handoff,req.prompt);
   const stageRequest:AgentExecutionRequest={
    ...req,runId,role,prompt,maxCostUsd:req.maxCostUsd-spent
   };
   emit({type:'stage_started',role,runId,actorId});
   result=await executeProvider(deps.provider,stageRequest,deps.signal);
   if(!result.output.trim())throw new PipelineBlocked(role,'PROVIDER_FAILED');
   spent+=result.usage.costUsd;
   if(spent>req.maxCostUsd+1e-10)throw new PipelineBlocked(role,'BUDGET_EXCEEDED');
   const outputSha256=Sha(result.output);
   if(role==='developer'){developerOutputSha256=outputSha256;developerText=result.output;}
   const trustedBase={role,actorId,runId,outputSha256,
    artifacts:result.artifacts.length,inputTokens:result.usage.inputTokens,
    outputTokens:result.usage.outputTokens,estimatedCostUsd:result.usage.costUsd,
    previousChainSha256:chain};
   let independentCheck:StageReceipt['independentCheck'];
   if(role==='qa'||role==='reviewer'){
    const check=CheckSchema.parse(await (role==='qa'?deps.qaCheck:deps.reviewerCheck)({
     role,projectId:req.projectId,taskId:req.taskId,pipelineRunId:req.runId,
     actorId,outputSha256,developerOutputSha256,
     previousStageSha256:receipts.at(-1)?.outputSha256??''
    },deps.signal));
    const source=role==='qa'?'external_test_runner':'independent_reviewer';
    // LLM agent output can never itself approve QA or a review. Examiner must be
    // distinct from all stage agent identities; evidence must match the stage.
    const inspected=role==='qa'?developerOutputSha256:outputSha256;
    if(!check.passed||check.source!==source||check.examinedSha256!==inspected||
       Object.values(actors).includes(check.examinerId)||
       receipts.some(r=>r.independentCheck?.examinerId===check.examinerId))
     throw new PipelineBlocked(role,'INDEPENDENT_GATE_FAILED');
    independentCheck={
     examinerId:check.examinerId,reportSha256:check.reportSha256,source:check.source
    };
   }
   if(deps.signal.aborted)throw new PipelineBlocked(role,'CANCELLED');
   chain=Sha(JSON.stringify({...trustedBase,independentCheck,previousChainSha256:chain}));
   const receipt:StageReceipt={...trustedBase,chainSha256:chain,...(independentCheck?{independentCheck}:{})};
   receipts.push(receipt);
   emit({type:'stage_completed',role,runId,receipt});
   previous=result.output;
  }catch(error){
   const code=error instanceof PipelineBlocked?error.code:
    deps.signal.aborted?'CANCELLED':'PROVIDER_FAILED';
   emit({type:'stage_blocked',role,code});
   throw error instanceof PipelineBlocked?error:new PipelineBlocked(role,code);
  }
 }
 if(!chain||receipts.length!==4)throw new PipelineBlocked('reviewer','PROVIDER_FAILED');
 // S15 is the sole human approval/merge authority. This pipeline never
 // transitions task FSM to approved, even if the model writes "APPROVED".
 return {status:'awaiting_human_approval',projectId:req.projectId,
  taskId:req.taskId,pipelineRunId:req.runId,stages:receipts,
  estimatedTotalUsd:spent,chainSha256:chain,humanApprovalRequired:true,gitIntegrated:false};
}
