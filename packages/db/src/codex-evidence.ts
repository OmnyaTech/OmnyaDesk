import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {EvidenceLedger} from './evidence-ledger.ts';
import {executeProvider,type AgentExecutionRequest,type AgentProvider,
 type AgentProviderEvent} from '../../contracts/src/provider.ts';

const digest=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
// This adapter is for an ALREADY authorized runtime; neither caller
// input nor the prompt can grant an SSH lease or tools/approval rights.
export class CodexEvidenceRecorder{
 private readonly ledger:EvidenceLedger;
 constructor(pool:Pool){this.ledger=new EvidenceLedger(pool);}
 async execute(provider:AgentProvider,request:AgentExecutionRequest,signal:AbortSignal){
  if(provider.id!=='codex')throw new Error('Codex evidence requires real adapter');
  const started=Date.now();
  const hashes:string[]=[],types:string[]=[];
  let terminal='failed';
  let outputSha:string|null=null;
  let usage:{inputTokens:number;outputTokens:number;costUsd:number}|null=null;
  let failure:string|null=null;
  try{
   const result=await executeProvider(provider,request,signal,(event:AgentProviderEvent)=>{
    types.push(event.type);
    if(event.type==='delta')hashes.push(digest(event.text));
   });
   usage=result.usage;outputSha=digest(result.output);
   terminal='completed';
   return {result,evidence:await this.save(request,types,hashes,terminal,outputSha,usage,null,started)};
  }catch(e){
   terminal=signal.aborted?'cancelled':'failed';
   failure=e instanceof Error?e.name:'UnknownError';
   await this.save(request,types,hashes,terminal,outputSha,usage,failure,started);
   throw e;
  }
 }
 private async save(req:AgentExecutionRequest,types:string[],hashes:string[],
  status:string,outputSha:string|null,
  usage:{inputTokens:number;outputTokens:number;costUsd:number}|null,
  failure:string|null,started:number){
  // Evidence is a content-free receipt, not raw model output, prompt or auth.
  const entry=await this.ledger.append({
   projectId:req.projectId,taskId:req.taskId,runId:req.runId,
   kind:'log',scopeKey:'provider:codex:'+req.runId,actorId:'codex-provider',
   content:JSON.stringify({status,runId:req.runId,modelId:req.modelId,
    durationMs:Date.now()-started,eventCount:types.length,eventTypes:types.slice(0,100),
    deltaHashes:hashes.slice(0,100),outputSha256:outputSha,
    usage,estimation:'USD estimate from operator-supplied token rates; not actual billing',
    failureType:failure}),
   metadata:{provider:'codex',status,runId:req.runId}
  });
  return {id:entry.id,version:entry.version,sha256:entry.contentSha256};
 }
}
