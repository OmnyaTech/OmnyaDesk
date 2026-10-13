import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,realpathSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';
import {validSha} from './git-driver.ts';
import {UbuntuSshTransport,safeLinuxPath,quoteRemote} from './remote-ubuntu.ts';

export class WorkspaceConflict extends Error{readonly status=409;}
export class WorkspaceNotFound extends Error{readonly status=404;}
export const WorktreeInput=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,baseSha:z.string().length(40),runId:UuidSchema.optional()
}).refine(x=>validSha(x.baseSha),{message:'Invalid Git SHA'});
export type WorktreeInput=z.input<typeof WorktreeInput>;
export type WorktreeRecord={projectId:string;taskId:string;runId:string;checkoutPath:string;
 branchRef:string;baseSha:string;state:string;executionBackend:string;remoteHost:string};
const localGit=(repo:string,...args:string[]):string=>{
 const r=spawnSync('git',['-C',repo,'-c','core.hooksPath=NUL',...args],{
  env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0'},
  encoding:'utf8',windowsHide:true,timeout:25000,maxBuffer:2*1024*1024
 });
 if(r.error||r.status!==0)throw new WorkspaceConflict('Canonical Git source rejected command');
 return r.stdout.trim();
};

export class RemoteWorktreeManager{
 private readonly pool:Pool;
 readonly ssh:UbuntuSshTransport;
 readonly root:string;
 constructor(pool:Pool,ssh:UbuntuSshTransport){
  this.pool=pool;this.ssh=ssh;this.root=safeLinuxPath(ssh.config.remoteRoot);
 }
 private path(projectId:string,runId:string):string{
  UuidSchema.parse(projectId);UuidSchema.parse(runId);
  return safeLinuxPath(this.root+'/projects/'+projectId+'/'+runId);
 }
 private async tx<T>(projectId:string,fn:(client:PoolClient,repo:string)=>Promise<T>,
  requireCanonicalSource=true):Promise<T>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12012))',['worktrees:'+projectId]);
   const result=await c.query<{repository_root:string|null}>(
    'SELECT repository_root FROM projects WHERE id=$1 FOR SHARE',[projectId]);
   if(!result.rowCount)throw new WorkspaceNotFound('Project not found');
   const repo=result.rows[0]!.repository_root;
   let canonical='';
   if(requireCanonicalSource){
    // Creating a new run needs the canonical local Git source; closing an
    // already registered Ubuntu worktree must survive reboot/temp clone removal.
    if(!repo||!isAbsolute(repo)||!existsSync(repo)||lstatSync(repo).isSymbolicLink())
     throw new WorkspaceConflict('Canonical source Git repo missing or unsafe');
    canonical=realpathSync(repo);
   }
   const value=await fn(c,canonical);
   await c.query('COMMIT');return value;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private validateTree(repo:string,commit:string):void{
  if(localGit(repo,'cat-file','-t',commit)!=='commit')throw new WorkspaceConflict('Base object is not a commit');
  const rows=localGit(repo,'ls-tree','-r','-l',commit).split(/\r?\n/).filter(Boolean);
  if(rows.length>350)throw new WorkspaceConflict('Tree exceeds 350 allowed files');
  let bytes=0;
  for(const line of rows){
   const match=/^([0-9]{6}) blob [a-f0-9]{40} +([0-9]+)\t(.+)$/.exec(line);
   if(!match||match[1]!=='100644')throw new WorkspaceConflict('Symlink, executable or submodule refused');
   const size=Number(match[2]),name=match[3]!;
   if(!Number.isSafeInteger(size)||size>1024*1024)throw new WorkspaceConflict('Oversize entry');
   if(!/^[a-zA-Z0-9._/-]+$/.test(name)||name.split('/').some(x=>x==='.'||x==='..'||!x)||
    name.split('/').some(x=>x==='.env'||x==='.ssh'||x==='.git'||x==='node_modules')||
    name==='.gitmodules'||name.includes('\\'))
    throw new WorkspaceConflict('Unsafe Git entry path');
   bytes+=size;
  }
  if(bytes>16*1024*1024)throw new WorkspaceConflict('Tree exceeds snapshot quota');
  if(!rows.some(x=>x.endsWith('\tentry.sh')))throw new WorkspaceConflict('entry.sh required');
 }
 async create(input:WorktreeInput):Promise<WorktreeRecord>{
  const x=WorktreeInput.parse(input),runId=x.runId??randomUUID();
  const remoteDir=this.path(x.projectId,runId);
  await this.ssh.connect();
  return this.tx(x.projectId,async(c,repo)=>{
   const task=await c.query('SELECT 1 FROM tasks WHERE project_id=$1 AND id=$2',
    [x.projectId,x.taskId]);
   if(!task.rowCount)throw new WorkspaceNotFound('Task not found in project');
   const busy=await c.query(
    "SELECT 1 FROM execution_worktrees WHERE project_id=$1 AND task_id=$2 AND state IN ('allocating','ready')",
    [x.projectId,x.taskId]);
   if(busy.rowCount)throw new WorkspaceConflict('Task already owns a worktree');
   this.validateTree(repo,x.baseSha);
   const dir=mkdtempSync(join(tmpdir(),'omnyadesk-s12-bundle-')),bundle=join(dir,'transfer.bundle');
   const branch='omnyadesk/s12/'+runId,checkout=remoteDir+'/workspace';
   let ownsRemoteDirectory=false;
   try{
    // Transfer ONLY the requested immutable commit and its reachable ancestry.
    // Never ship unrelated project refs or other task branches with --all.
    const stagedRepo=join(dir,'selected.git');
    const initialized=spawnSync('git',['init','--bare',stagedRepo],{
     encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024
    });
    if(initialized.status!==0)throw new WorkspaceConflict('Scoped Git stage could not be initialized');
    localGit(stagedRepo,'fetch','--no-tags','--no-write-fetch-head',repo,x.baseSha);
    if(localGit(stagedRepo,'rev-parse','--verify',x.baseSha+'^{commit}')!==x.baseSha)
     throw new WorkspaceConflict('Scoped bundle SHA differs from requested commit');
    localGit(stagedRepo,'update-ref','refs/heads/s12-base',x.baseSha);
    localGit(stagedRepo,'bundle','create',bundle,'refs/heads/s12-base');
    if(statSync(bundle).size>64*1024*1024)throw new WorkspaceConflict('Bundle exceeds 64MiB');
    const exists=await this.ssh.requireOk('if test -e '+quoteRemote(remoteDir)+
     ' || test -L '+quoteRemote(remoteDir)+'; then echo OCCUPIED; else echo AVAILABLE; fi');
    if(exists!=='AVAILABLE')throw new WorkspaceConflict('Remote run directory occupied');
    await c.query(
     "INSERT INTO execution_worktrees(project_id,task_id,run_id,branch_ref,base_sha,checkout_path,"+
     "state,execution_backend,remote_host,sandbox_image) "+
     "VALUES($1,$2,$3,$4,$5,$6,'allocating','ubuntu_ssh_docker',$7,$8)",
     [x.projectId,x.taskId,runId,branch,x.baseSha,checkout,this.ssh.config.host,this.ssh.config.image]);
    await this.ssh.requireOk('umask 077; mkdir -p '+
     quoteRemote(this.root+'/projects/'+x.projectId)+' && mkdir '+quoteRemote(remoteDir)+
     ' && test ! -L '+quoteRemote(remoteDir)+' && test -d '+quoteRemote(remoteDir));
    ownsRemoteDirectory=true;
    await this.ssh.upload(bundle,remoteDir+'/transfer.bundle');
    await this.ssh.requireOk(
     'git clone --quiet --bare '+quoteRemote(remoteDir+'/transfer.bundle')+' '+quoteRemote(remoteDir+'/source.git')+
     ' && git -C '+quoteRemote(remoteDir+'/source.git')+' -c core.hooksPath=/dev/null worktree add -b '+
     quoteRemote(branch)+' '+quoteRemote(checkout)+' '+quoteRemote(x.baseSha)+
     ' && test "$(git -C '+quoteRemote(checkout)+' rev-parse HEAD)" = '+quoteRemote(x.baseSha)+
     ' && test ! -L '+quoteRemote(checkout),40000);
    await this.ssh.requireOk('rm -f '+quoteRemote(remoteDir+'/transfer.bundle'));
    await c.query("UPDATE execution_worktrees SET state='ready' WHERE project_id=$1 AND run_id=$2",
     [x.projectId,runId]);
    return {projectId:x.projectId,taskId:x.taskId,runId,checkoutPath:checkout,
     branchRef:branch,baseSha:x.baseSha,state:'ready',executionBackend:'ubuntu_ssh_docker',
     remoteHost:this.ssh.config.host};
   }catch(error){
    // Never delete a path that was present before this attempt (collision/race).
    if(ownsRemoteDirectory){
     try{await this.ssh.exec('if test ! -L '+quoteRemote(remoteDir)+
      '; then rm -rf -- '+quoteRemote(remoteDir)+'; fi',12000)}catch{/* fail closed */}
    }
    throw error;
   }finally{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:200});}
  });
 }
 async get(projectId:string,runId:string):Promise<WorktreeRecord|null>{
  UuidSchema.parse(projectId);UuidSchema.parse(runId);
  const q=await this.pool.query('SELECT * FROM execution_worktrees WHERE project_id=$1 AND run_id=$2',
   [projectId,runId]);
  if(!q.rowCount)return null;
  const r=q.rows[0]!;
  return {projectId,runId,taskId:r.task_id,checkoutPath:r.checkout_path,
   branchRef:r.branch_ref,baseSha:r.base_sha,state:r.state,
   executionBackend:r.execution_backend,remoteHost:r.remote_host};
 }
 async close(projectId:string,runId:string):Promise<boolean>{
  this.path(projectId,runId);
  await this.ssh.connect();
  return this.tx(projectId,async(c)=>{
   const q=await c.query('SELECT * FROM execution_worktrees WHERE project_id=$1 AND run_id=$2 FOR UPDATE',
    [projectId,runId]);
   if(!q.rowCount)return false;
   const row=q.rows[0];
   if(row.state==='closed')return true;
   const dir=this.path(projectId,runId),checkout=dir+'/workspace';
   if(row.execution_backend!=='ubuntu_ssh_docker'||row.remote_host!==this.ssh.config.host||
     row.checkout_path!==checkout||row.state!=='ready')
    throw new WorkspaceConflict('Remote worktree ownership inconsistent');
   const result=await this.ssh.exec('test -d '+quoteRemote(checkout)+' && test ! -L '+quoteRemote(checkout)+
    ' && test -z "$(git -C '+quoteRemote(checkout)+' status --porcelain)"',12000);
   if(result.exitCode!==0)throw new WorkspaceConflict('Dirty or missing worktree preserved');
   await this.ssh.requireOk(
    'git -C '+quoteRemote(dir+'/source.git')+' -c core.hooksPath=/dev/null worktree remove '+
    quoteRemote(checkout)+' && test ! -L '+quoteRemote(dir)+
    ' && rm -rf -- '+quoteRemote(dir),22000);
   await c.query("UPDATE execution_worktrees SET state='closed',closed_at=now() WHERE project_id=$1 AND run_id=$2",
    [projectId,runId]);
   return true;
  },false);
 }
}
