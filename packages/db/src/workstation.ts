import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {realpath,lstat} from 'node:fs/promises';
import {isAbsolute,resolve,relative,parse,sep,delimiter} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';
import {TokenStore} from './tokens.ts';

export const WorkstationSecret=/^ods_[a-f0-9]{64}$/;
export const WorkstationProjectInput=z.strictObject({
 path:z.string().min(3).max(2048),
 name:z.string().trim().min(1).max(140)
});
const normalized=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
function contains(root:string,child:string):boolean{
 const rel=relative(root,child);
 return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}
// Policy defaults to DENY; only explicitly configured roots can contain a project.
// A junction/symlink in *any* descendant path component is rejected, even when its
// final canonical target happens to reside inside an allowed root.
export async function verifiedFolder(candidate:string,allowedRaw:string):Promise<string>{
 if(!isAbsolute(candidate)||!allowedRaw.trim())throw Error('Project folder not allowed');
 const requested=resolve(candidate);
 const approved=allowedRaw.split(delimiter).map(x=>x.trim()).filter(Boolean);
 if(approved.length===0)throw Error('Project folder not allowed');
 const roots=await Promise.all(approved.map(async root=>{
  if(!isAbsolute(root))throw Error('Unqualified workstation allowlist root');
  return realpath(resolve(root));
 }));
 const real=await realpath(requested);
 if(normalized(real)!==normalized(requested))throw Error('Symlink or junction path forbidden');
 if(!roots.some(root=>contains(normalized(root),normalized(real))))
  throw Error('Project folder outside authorized roots');
 let cursor=requested;
 for(;;){
  const stat=await lstat(cursor);
  if(stat.isSymbolicLink())throw Error('Symlink or junction forbidden');
  const parent=resolve(cursor,'..');
  if(parent===cursor||cursor===parse(cursor).root)break;
  cursor=parent;
 }
 const final=await lstat(real);
 if(!final.isDirectory())throw Error('Project path must be a directory');
 return real;
}
export class WorkstationRegistry{
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async issue(subjectId:string,hours=720):Promise<{secret:string;id:string;expiresAt:string}>{
  UuidSchema.parse(subjectId);
  if(!Number.isInteger(hours)||hours<1||hours>720)throw Error('Invalid lifetime');
  const id=randomUUID(),secret='ods_'+randomBytes(32).toString('hex');
  const expiresAt=new Date(Date.now()+hours*3600000).toISOString();
  await this.pool.query(
   'INSERT INTO workstation_sessions(id,subject_id,secret_sha256,expires_at) VALUES($1,$2,$3,$4)',
   [id,subjectId,createHash('sha256').update(secret).digest('hex'),expiresAt]);
  return {secret,id,expiresAt};
 }
 async authenticate(header:unknown):Promise<{id:string;subjectId:string}|null>{
  if(typeof header!=='string'||!/^Bearer ods_[a-f0-9]{64}$/.test(header))return null;
  const digest=createHash('sha256').update(header.slice(7)).digest('hex');
  const r=await this.pool.query(
   'SELECT id,subject_id FROM workstation_sessions WHERE secret_sha256=$1 AND revoked_at IS NULL AND expires_at>now()',
   [digest]);
  return r.rowCount?{id:r.rows[0].id,subjectId:r.rows[0].subject_id}:null;
 }
 async projects(workstationId:string){
  const r=await this.pool.query(`SELECT p.id,p.name,p.repository_root AS "repositoryRoot",
   w.canonical_root AS "localRoot" FROM workstation_projects w
   JOIN projects p ON p.id=w.project_id WHERE w.workstation_id=$1 ORDER BY w.created_at,p.id LIMIT 500`,[workstationId]);
  return r.rows as {id:string;name:string;repositoryRoot:string|null;localRoot:string}[];
 }
 async register(workstation:{id:string;subjectId:string},raw:unknown,allowedRoots:string){
  const input=WorkstationProjectInput.parse(raw);
  const path=await verifiedFolder(input.path,allowedRoots);
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   // Prevent duplicate folder registration and races for the same workstation.
   const valid=await c.query('SELECT id FROM workstation_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',[workstation.id]);
   if(!valid.rowCount)throw Error('Workstation session expired or revoked');
   const exists=await c.query('SELECT project_id FROM workstation_projects WHERE workstation_id=$1 AND lower(canonical_root)=lower($2)',[workstation.id,path]);
   if(exists.rowCount)throw Error('Folder already registered');
   // Use the same transaction for both the ACL and the new project; no orphaned grants.
   const id=randomUUID(),officeId=randomUUID();
   await c.query('INSERT INTO projects(id,owner_id,name,repository_root) VALUES($1,$2,$3,$4)',
     [id,workstation.subjectId,input.name,path]);
   await c.query('INSERT INTO offices(id,project_id,name,template) VALUES($1,$2,$3,$4)',
     [officeId,id,'Default','custom']);
   await c.query('INSERT INTO workstation_projects(workstation_id,project_id,canonical_root) VALUES($1,$2,$3)',
     [workstation.id,id,path]);
   await c.query('COMMIT');
   return {id,name:input.name,localRoot:path};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async readonlyToken(workstation:{id:string;subjectId:string},projectId:string){
  UuidSchema.parse(projectId);
  const r=await this.pool.query('SELECT 1 FROM workstation_projects WHERE workstation_id=$1 AND project_id=$2',
    [workstation.id,projectId]);
  if(!r.rowCount)return null;
  // No grant of execution or approval privileges: S10/S13/S15 remain enforced.
  return new TokenStore(this.pool).provision({projectId,subjectId:workstation.subjectId,
   kind:'human',scopes:['projects:read','tasks:read','events:read'],
   expiresInHours:1,origin:'web',channel:'api'});
 }
}
