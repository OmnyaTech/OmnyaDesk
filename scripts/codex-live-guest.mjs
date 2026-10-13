import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {CodexProvider} from './packages/adapters/src/codex.js';
import {executeProvider} from './packages/contracts/src/provider.js';

// Guest runs ONLY in isolated, read-only Docker with an S12 worktree.
// Stdout contains hashes/usage, never prompt, raw response, auth, or device code.
const req=JSON.parse(readFileSync('/runtime/pilot/request.json','utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),85000);
let sequences=[],events=[],deltaHashes=[],receipt;
try{
 const provider=new CodexProvider({
  pricing:{inputUsdPerMillion:2,outputUsdPerMillion:8,cachedInputUsdPerMillion:0.5},
  workspace:()=>{throw new Error('Real client must enforce its own canonical sandbox guard');},
  timeoutMs:80000
 });
 const result=await executeProvider(provider,req,controller.signal,e=>{
  events.push(e.type);sequences.push(e.sequence);
  if(e.type==='delta')deltaHashes.push(hash(e.text));
 });
 receipt={status:'completed',provider:'codex',projectId:req.projectId,
  taskId:req.taskId,runId:req.runId,modelId:req.modelId,
  eventTypes:events,sequence:sequences,deltaHashes,
  outputSha256:hash(result.output),outputLength:result.output.length,
  usage:result.usage,artifacts:result.artifacts.length};
}catch(err){
 receipt={status:'failed',provider:'codex',projectId:req.projectId,
  taskId:req.taskId,runId:req.runId,modelId:req.modelId,
  eventTypes:events,sequence:sequences,deltaHashes,
  errorName:err?.name??'Unknown',errorCode:err?.code??'unspecified'};
 process.exitCode=1;
}finally{clearTimeout(timer);}
console.log('S17_PILOT_RECEIPT='+JSON.stringify(receipt));
