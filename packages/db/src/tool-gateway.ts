import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {Pool} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';
import {RemoteWorktreeManager} from './remote-worktrees.ts';
import {UbuntuDockerSandbox} from './remote-docker-sandbox.ts';
import {quoteRemote} from './remote-ubuntu.ts';
import {EvidenceLedger} from './evidence-ledger.ts';

export class ToolDenied extends Error {readonly status=403;}
export class ToolUnavailable extends Error {readonly status=409;}
export class ToolLimit extends Error {readonly status=413;}
const RelativePath=z.string().min(1).max(190).refine(value=>
 value==='.'||(/^[A-Za-z0-9_./-]+$/.test(value)&&
  value.split('/').every(segment=>!!segment&&segment!=='.'&&segment!=='..'&&
   !segment.startsWith('.')&&!segment.startsWith('-')&&!['node_modules','dist','entry.sh'].includes(segment))),{
 message:'Restricted relative path'
});
const FilePath=RelativePath.refine(value=>value!=='.'&&
 /\.(md|txt|json|ts|tsx|js|css|html)$/.test(value),{message:'File extension not allowed'});
const Base=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,runId:UuidSchema,
 workerId:z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
 leaseToken:UuidSchema,fence:z.number().int().positive()
});
export const ToolRequestSchema=z.discriminatedUnion('tool',[
 Base.extend({tool:z.literal('git.status')}),
 Base.extend({tool:z.literal('git.diff'),path:FilePath.optional()}),
 Base.extend({tool:z.literal('files.read'),path:FilePath}),
 Base.extend({tool:z.literal('files.list'),path:RelativePath.default('.')}),
 Base.extend({tool:z.literal('files.write'),path:FilePath,
  content:z.string().min(1).max(16384),
  expectedSha:z.union([z.literal('absent'),z.string().regex(/^[a-f0-9]{64}$/)])}),
 Base.extend({tool:z.literal('tests.run'),suite:z.literal('entry')})
]);
export type ToolRequest=z.input<typeof ToolRequestSchema>;
export type ToolReply={tool:string;success:boolean;result:unknown;durationMs:number;
 evidence:{id:string;version:number;sha256:string}};
type Parsed=z.output<typeof ToolRequestSchema>;
const fileScript=fileURLToPath(new URL('../../../scripts/remote-tool-files.py',import.meta.url));
const hashes=(text:string)=>createHash('sha256').update(text).digest('hex');
function covers(heldKey:string,heldMode:string,required:string,needWrite:boolean):boolean{
 if(needWrite&&heldMode!=='write')return false;
 if(heldKey==='repo')return true;
 if(required==='repo'||!required.startsWith('path:')||!heldKey.startsWith('path:'))return false;
 const own=heldKey.slice(5),goal=required.slice(5);
 return goal===own||goal.startsWith(own+'/');
}
function resourceOf(request:Parsed):{key:string;write:boolean}{
 switch(request.tool){
  case 'files.read':return {key:'path:'+request.path.toLowerCase(),write:false};
  case 'files.write':return {key:'path:'+request.path.toLowerCase(),write:true};
  case 'files.list':return request.path==='.'?{key:'repo',write:false}:
   {key:'path:'+request.path.toLowerCase(),write:false};
  case 'git.status':
  case 'git.diff':
  case 'tests.run':return {key:'repo',write:false};
 }
}
export class UbuntuToolGateway{
 private readonly pool:Pool;
 private readonly manager:RemoteWorktreeManager;
 private readonly docker:UbuntuDockerSandbox;
 private readonly evidence:EvidenceLedger;
 constructor(pool:Pool,manager:RemoteWorktreeManager){
  this.pool=pool;this.manager=manager;this.docker=new UbuntuDockerSandbox(manager);
  this.evidence=new EvidenceLedger(pool);
  if(!existsSync(fileScript))throw new ToolUnavailable('Trusted helper not available');
 }
 private async authorize(r:Parsed):Promise<string>{
  const row=await this.manager.get(r.projectId,r.runId);
  if(!row||row.state!=='ready'||row.executionBackend!=='ubuntu_ssh_docker'||
   row.remoteHost!==this.manager.ssh.config.host||row.taskId!==r.taskId||
   row.checkoutPath!==this.manager.root+'/projects/'+r.projectId+'/'+r.runId+'/workspace')
   throw new ToolDenied('Tool request outside task worktree');
  const required=resourceOf(r);
  const margin=r.tool==='tests.run'?28000:6000;
  const actual=await this.pool.query<{resource_key:string;access_mode:'read'|'write'}>(
   'SELECT l.resource_key,l.access_mode FROM scheduled_tasks s '+
   'JOIN resource_leases l ON l.project_id=s.project_id AND l.task_id=s.task_id '+
   'AND l.fence=s.fence AND l.expires_at>clock_timestamp()+($7::int * interval \'1 millisecond\') '+
   'WHERE s.project_id=$1 AND s.task_id=$2 AND s.worker_id=$3 AND '+
   's.lease_token=$4 AND s.fence=$5 AND s.state=\'running\' AND '+
   's.lease_until>clock_timestamp()+($7::int * interval \'1 millisecond\') AND l.project_id=$6',
   [r.projectId,r.taskId,r.workerId,r.leaseToken,r.fence,r.projectId,margin]);
  if(!actual.rows.some(x=>covers(x.resource_key,x.access_mode,required.key,required.write)))
   throw new ToolDenied('Missing live S10 lease and required resource authorization');
  return row.checkoutPath;
 }
 private async file(r:Extract<Parsed,{tool:'files.read'|'files.list'|'files.write'}>,
  checkout:string):Promise<unknown>{
  const ssh=this.manager.ssh,runDir=checkout.slice(0,-('/workspace'.length));
  // Distinct trusted helper per request prevents concurrent SFTP uploads from clobbering code.
  const helper=runDir+'/s13-'+randomUUID()+'.py';
  try{
   await ssh.upload(fileScript,helper);
   const op=r.tool.split('.')[1]!;
   const args=['python3',quoteRemote(helper),quoteRemote(op),quoteRemote(checkout),quoteRemote(r.path)];
   if(r.tool==='files.write'){
    if(Buffer.byteLength(r.content,'utf8')>16384)throw new ToolLimit('Write budget exceeded');
    args.push(quoteRemote(Buffer.from(r.content,'utf8').toString('base64')),quoteRemote(r.expectedSha));
   }
   const out=await ssh.exec(args.join(' '),5000);
   if(out.exitCode!==0)throw new ToolDenied('Remote file operation denied: '+
    (out.stderr.trim().match(/^[A-Z_]{3,60}$/)?.[0]??'POLICY_DENIED'));
   if(out.stdout.length>24000)throw new ToolLimit('File output budget exceeded');
   try{return JSON.parse(out.stdout) as unknown;}
   catch{throw new ToolUnavailable('Malformed remote file result');}
  }finally{
   await ssh.exec('rm -f -- '+quoteRemote(helper),5000).catch(()=>{});
  }
 }
 private async git(r:Extract<Parsed,{tool:'git.status'|'git.diff'}>,checkout:string):Promise<unknown>{
  const q=quoteRemote;
  const base='git -C '+q(checkout)+' -c core.hooksPath=/dev/null';
  const cmd=r.tool==='git.status'
   ?base+' status --porcelain --untracked-files=no'
   :base+' -c diff.external=/usr/bin/false diff --no-ext-diff --no-textconv --'+
    (r.path?' '+q(r.path):'');
  const res=await this.manager.ssh.exec(cmd,8000);
  if(res.exitCode!==0)throw new ToolUnavailable('Read-only Git operation rejected');
  if(Buffer.byteLength(res.stdout,'utf8')>16384)throw new ToolLimit('Git output budget exceeded');
  return {text:res.stdout,sha256:hashes(res.stdout)};
 }
 async run(raw:ToolRequest):Promise<ToolReply>{
  const r=ToolRequestSchema.parse(raw);
  const start=Date.now();
  const checkout=await this.authorize(r);
  await this.manager.ssh.connect();
  let result:unknown;
  switch(r.tool){
   case 'git.status':
   case 'git.diff':result=await this.git(r,checkout);break;
   case 'files.read':
   case 'files.list':
   case 'files.write':result=await this.file(r,checkout);break;
   case 'tests.run':{
    const out=await this.docker.run(r.projectId,r.runId);
    if(Buffer.byteLength(out.stdout,'utf8')>16384||Buffer.byteLength(out.stderr,'utf8')>2048)
     throw new ToolLimit('Test output budget exceeded');
    result={suite:r.suite,exitCode:out.exitCode,stdout:out.stdout,stderr:out.stderr};
    break;
   }
   default:throw new ToolDenied('Unlisted operation');
  }
  if(r.tool==='tests.run'){
   const state=await this.pool.query(
    'SELECT 1 FROM scheduled_tasks WHERE project_id=$1 AND task_id=$2 AND '+
    'worker_id=$3 AND lease_token=$4 AND fence=$5 AND state=\'running\' AND '+
    'lease_until>clock_timestamp()',
    [r.projectId,r.taskId,r.workerId,r.leaseToken,r.fence]);
   if(!state.rowCount)throw new ToolDenied('S10 fencing changed during test run');
  }else await this.authorize(r);
  const success=r.tool==='tests.run'?(result as {exitCode:number}).exitCode===0:true;
  // Record only bounded tool output or a content-free receipt for file reads.
  // No lease token, SSH details, file contents or credentials enter metadata.
  const kind=r.tool==='git.diff'?'diff':r.tool==='files.write'?'artifact':'log';
  const content=r.tool==='git.diff'||r.tool==='git.status'
   ?(result as {text:string}).text
   :r.tool==='tests.run'||r.tool==='files.write'
    ?JSON.stringify(result)
    :JSON.stringify({operation:r.tool,path:r.path,receiptSha256:hashes(JSON.stringify(result))});
  const record=await this.evidence.append({projectId:r.projectId,taskId:r.taskId,
   runId:r.runId,kind,scopeKey:'tool:'+r.tool.replace('.','-')+':'+r.runId,
   actorId:r.workerId,content,metadata:{tool:r.tool,success,fence:r.fence}});
  return {tool:r.tool,success,result,durationMs:Date.now()-start,
   evidence:{id:record.id,version:record.version,sha256:record.contentSha256}};
 }
}
