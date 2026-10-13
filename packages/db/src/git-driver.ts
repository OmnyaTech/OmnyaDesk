import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';

const SHA=/^[a-f0-9]{40}$/;
const REF=/^refs\/heads\/[a-z0-9][a-z0-9/_-]{0,150}$/;
const POLICY='s11-combined-readonly-v1';
export class GitValidationError extends Error {}
export type CombinedCheck={name:string;passed:boolean};
export type PreparedGit={targetHead:string;candidateSha:string;tree:string;commit:string;
 reviewHash:string;checks:CombinedCheck[]};
export function validSha(value:string):boolean{return SHA.test(value);}
export function validRef(value:string):boolean{
 return REF.test(value)&&!value.includes('//')&&!value.includes('..')&&
  !value.endsWith('/')&&!value.endsWith('.lock');
}
export class BareGitIntegration{
 readonly path:string;
 constructor(repoRoot:string){
  if(!repoRoot||!isAbsolute(repoRoot))throw new GitValidationError('Repository root must be absolute');
  if(lstatSync(repoRoot).isSymbolicLink())throw new GitValidationError('Repository symlink not allowed');
  this.path=realpathSync(repoRoot);
  if(this.exec(['rev-parse','--is-bare-repository']).trim()!=='true')
   throw new GitValidationError('S11 only integrates dedicated bare repositories');
  if(this.exec(['rev-parse','--show-object-format']).trim()!=='sha1')
   throw new GitValidationError('Only SHA1 Git object IDs are supported in this version');
 }
 private exec(args:string[],options:{max?:number;env?:Record<string,string>}={}):string{
  const environment={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',
   GIT_OPTIONAL_LOCKS:'1',GIT_AUTHOR_NAME:'OmnyaDesk Integration',
   GIT_AUTHOR_EMAIL:'integration@omnyadesk.local',GIT_COMMITTER_NAME:'OmnyaDesk Integration',
   GIT_COMMITTER_EMAIL:'integration@omnyadesk.local',GIT_CONFIG_GLOBAL:'NUL',
   ...options.env};
  const command=spawnSync('git',['-C',this.path,
    '-c','core.hooksPath=NUL','-c','commit.gpgsign=false','-c','tag.gpgsign=false',
    '-c','protocol.file.allow=never',...args],{
    encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:options.max??1024*1024,
    env:environment
  });
  if(command.error||command.status!==0)
   throw new GitValidationError('Git validation or ref update failed');
  return command.stdout;
 }
 private output(args:string[],max=1024*1024):{status:number;stdout:string}{
  const res=spawnSync('git',['-C',this.path,'-c','core.hooksPath=NUL',
   '-c','commit.gpgsign=false',...args],{
   encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:max,
   env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',
    GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'1'}
  });
  if(res.error||res.status===null)throw new GitValidationError('Git process failed');
  return {status:res.status,stdout:res.stdout};
 }
 head():string{
  const ref=this.exec(['rev-parse','--verify','refs/heads/main']).trim();
  if(!validSha(ref))throw new GitValidationError('Invalid target Git HEAD');
  return ref;
 }
 verifyCandidate(candidateRef:string,baseSha:string,candidateSha:string):void{
  if(!validRef(candidateRef)||candidateRef==='refs/heads/main'||!validSha(baseSha)||!validSha(candidateSha))
   throw new GitValidationError('Invalid candidate ref or commit');
  if(this.exec(['rev-parse','--verify',candidateRef]).trim()!==candidateSha)
   throw new GitValidationError('Candidate branch changed');
  if(this.output(['merge-base','--is-ancestor',baseSha,candidateSha]).status!==0)
   throw new GitValidationError('Declared base is not ancestor of candidate');
  if(this.output(['merge-base','--is-ancestor',baseSha,this.head()]).status!==0)
   throw new GitValidationError('Declared base is not part of integration target history');
  if(baseSha===candidateSha)throw new GitValidationError('Empty candidate');
 }
 prepare(candidateRef:string,baseSha:string,candidateSha:string,requestId:string,
  stableDate:string):PreparedGit{
  this.verifyCandidate(candidateRef,baseSha,candidateSha);
  const head=this.head();
  const merged=this.output(['merge-tree','--write-tree',head,candidateSha],1024*1024);
  if(merged.status!==0)throw new GitValidationError('Git merge conflict; manual rework required');
  const tree=merged.stdout.trim().split(/\r?\n/)[0]?.trim()??'';
  if(!validSha(tree))throw new GitValidationError('Merge did not produce a valid tree');
  if(this.exec(['rev-parse',head+'^{tree}']).trim()===tree)
   throw new GitValidationError('Merged candidate produces no change');
  const checks=this.validateCombined(head,tree);
  const payload=JSON.stringify({policy:POLICY,requestId,head,baseSha,candidateSha,tree,checks});
  const reviewHash=createHash('sha256').update(payload).digest('hex');
  const date=new Date(stableDate).toISOString();
  const commit=this.exec(['commit-tree',tree,'-p',head,'-p',candidateSha,
   '-m','OmnyaDesk reviewed integration '+requestId],{
    env:{GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}
   }).trim();
  if(!validSha(commit))throw new GitValidationError('Invalid planned commit');
  return {targetHead:head,candidateSha,tree,commit,reviewHash,checks};
 }
 private validateCombined(head:string,tree:string):CombinedCheck[]{
  const check=this.output(['diff','--check',head,tree]);
  if(check.status!==0)throw new GitValidationError('Combined diff failed whitespace checks');
  const listing=this.exec(['ls-tree','-r','-z',tree],{max:3*1024*1024});
  const items=listing.split('\0').filter(Boolean);
  if(items.length>500)throw new GitValidationError('Combined tree exceeds safe size limits');
  let parsedJson=0,checkedFiles=0;
  const registryIds=new Set<string>();
  for(const item of items){
   const match=/^([0-9]{6}) (blob|commit) ([a-f0-9]{40})\t([^\0]+)$/.exec(item);
   if(!match)throw new GitValidationError('Unsafe tree entry');
   const [,mode,kind,oid,path]=match;
   if(mode!=='100644'||kind!=='blob'||path==='.gitmodules'||
     path.startsWith('.git/')||path.includes('\\')||path.includes('\n')||
     path.split('/').some(segment=>segment==='..'||segment==='.'||segment===''))
    throw new GitValidationError('Symlink, executable, submodule or unsafe path rejected');
   const size=Number(this.exec(['cat-file','-s',oid]).trim());
   if(!Number.isSafeInteger(size)||size>131072)throw new GitValidationError('File too large for safe validation');
   checkedFiles++;
   if(path.endsWith('.json')){
    let parsed:unknown;
    try{parsed=JSON.parse(this.exec(['cat-file','blob',oid],{max:131072+8192}));}
    catch{throw new GitValidationError('Combined JSON validation failed');}
    parsedJson++;
    if(path==='integrations/registry.json'){
     if(!Array.isArray(parsed))throw new GitValidationError('Registry must be a JSON array');
     for(const row of parsed){
      if(!row||typeof row!=='object'||Array.isArray(row))throw new GitValidationError('Invalid registry entry');
      const id=(row as Record<string,unknown>).id;
      if(typeof id!=='string'||!/^[a-z0-9_-]{1,50}$/.test(id)||registryIds.has(id))
       throw new GitValidationError('Combined registry has duplicate or invalid ID');
      registryIds.add(id);
     }
    }
    if(path.startsWith('integrations/registry/')&&path.endsWith('.json')){
     if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
      throw new GitValidationError('Registry shard must be an object');
     const id=(parsed as Record<string,unknown>).id;
     if(typeof id!=='string'||!/^[a-z0-9_-]{1,50}$/.test(id)||registryIds.has(id))
      throw new GitValidationError('Combined registry has duplicate or invalid ID');
     registryIds.add(id);
    }
   }
  }
  return [{name:'git-diff-check',passed:true},{name:'safe-tree-types',passed:true},
   {name:'json-syntax-'+parsedJson,passed:true},{name:'combined-file-count-'+checkedFiles,passed:true},
   {name:'registry-unique-ids',passed:true}];
 }
 apply(expectedHead:string,plannedCommit:string):'merged'|'already_moved'{
  if(!validSha(expectedHead)||!validSha(plannedCommit))throw new GitValidationError('Invalid merge object');
  const head=this.head();
  if(head===plannedCommit)return 'already_moved';
  if(head!==expectedHead)throw new GitValidationError('Target HEAD changed; revalidation required');
  // Atomic compare-and-swap updates ONLY the bare repository ref, not a checked-out working tree.
  this.exec(['update-ref','refs/heads/main',plannedCommit,expectedHead]);
  return 'merged';
 }
}
