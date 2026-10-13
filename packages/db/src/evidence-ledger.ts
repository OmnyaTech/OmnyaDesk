import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';

export class EvidenceIntegrityError extends Error{readonly status=409;}
export class EvidenceNotFound extends Error{readonly status=404;}
const SHA=/^[a-f0-9]{64}$/;
export const EvidenceInputSchema=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,runId:UuidSchema.nullable().default(null),
 kind:z.enum(['log','diff','artifact','review_diff','review_approval','review_decision']),
 scopeKey:z.string().min(1).max(180).regex(/^[A-Za-z0-9_./:-]+$/).refine(value=>!value.includes('..')&&!value.startsWith('/')&&!value.includes('//')),
 actorId:z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/),
 content:z.string().max(65536),
 metadata:z.record(z.string(),z.unknown()).default({})
});
export type EvidenceInput=z.input<typeof EvidenceInputSchema>;
export type EvidenceEntry={id:string;projectId:string;taskId:string;runId:string|null;
 kind:string;scopeKey:string;actorId:string;version:number;content:string;contentSha256:string;
 previousChain:string|null;chainSha256:string;metadata:Record<string,unknown>;createdAt:string};
type Row={id:string;project_id:string;task_id:string;run_id:string|null;kind:string;
 scope_key:string;actor_id:string;version:number;content:Buffer;content_sha256:string;
 previous_chain:string|null;chain_sha256:string;metadata:Record<string,unknown>;
 canonical_metadata?:string;created_at:Date};
type Db=Pool|PoolClient;
const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');

export class EvidenceLedger{
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async append(raw:EvidenceInput):Promise<EvidenceEntry>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   const value=await this.appendTx(c,raw);
   await c.query('COMMIT');return value;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async appendTx(c:PoolClient,raw:EvidenceInput):Promise<EvidenceEntry>{
  const x=EvidenceInputSchema.parse(raw),data=Buffer.from(x.content,'utf8');
  if(data.length>65536)throw new EvidenceIntegrityError('Content budget exceeded');
  if(JSON.stringify(x.metadata).length>1800)throw new EvidenceIntegrityError('Metadata budget exceeded');
  const key=[x.projectId,x.taskId,x.kind,x.scopeKey].join(':');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,14014))',['evidence:'+key]);
  const prev=await c.query<Row>(
   'SELECT * FROM evidence_entries WHERE project_id=$1 AND task_id=$2 AND kind=$3 AND scope_key=$4 ORDER BY version DESC LIMIT 1',
   [x.projectId,x.taskId,x.kind,x.scopeKey]);
  const before=prev.rows[0];
  const args=[randomUUID(),x.projectId,x.taskId,x.runId,x.kind,x.scopeKey,
   (before?.version??0)+1,x.actorId,data,sha(data),JSON.stringify(x.metadata),
   before?.chain_sha256??null];
  // Postgres canonical jsonb::text is used both when inserting and independently
  // verifying the SHA-256 chain. Trigger validates payload, order and ownership.
  const sql=[
   'WITH draft AS (SELECT $1::uuid id,$2::uuid project_id,$3::uuid task_id,',
   '$4::uuid run_id,$5::varchar kind,$6::varchar scope_key,$7::int version,',
   '$8::varchar actor_id,$9::bytea content,$10::char(64) content_sha256,',
   '$11::jsonb metadata,$12::char(64) previous_chain)',
   'INSERT INTO evidence_entries(id,project_id,task_id,run_id,kind,scope_key,version,actor_id,',
   'content,content_sha256,metadata,previous_chain,chain_sha256)',
   'SELECT id,project_id,task_id,run_id,kind,scope_key,version,actor_id,content,',
   'content_sha256,metadata,previous_chain,',
   "encode(digest(convert_to(concat_ws('|',COALESCE(previous_chain,''),project_id::text,",
   'task_id::text,kind,scope_key,version::text,content_sha256,metadata::text,',
   "COALESCE(run_id::text,''),actor_id),'UTF8'),'sha256'),'hex')",
   'FROM draft RETURNING *'
  ].join(' ');
  const result=await c.query<Row>(sql,args);
  return this.row(result.rows[0]!);
 }
 private row(r:Row):EvidenceEntry{
  const content=r.content.toString('utf8');
  if(!Buffer.from(content,'utf8').equals(r.content))
   throw new EvidenceIntegrityError('Non UTF-8 evidence');
  return {id:r.id,projectId:r.project_id,taskId:r.task_id,runId:r.run_id,kind:r.kind,
   scopeKey:r.scope_key,actorId:r.actor_id,version:r.version,content,
   contentSha256:r.content_sha256.trim(),previousChain:r.previous_chain?.trim()??null,
   chainSha256:r.chain_sha256.trim(),metadata:r.metadata,createdAt:r.created_at.toISOString()};
 }
 async verify(projectId:string,taskId:string,kind:string,scopeKey:string,db:Db=this.pool):
 Promise<{count:number;head:string|null}>{
  UuidSchema.parse(projectId);UuidSchema.parse(taskId);
  EvidenceInputSchema.pick({kind:true,scopeKey:true}).parse({kind,scopeKey});
  const rows=await db.query<Row>(
   'SELECT *,metadata::text canonical_metadata FROM evidence_entries WHERE project_id=$1 AND task_id=$2 AND kind=$3 AND scope_key=$4 ORDER BY version',
   [projectId,taskId,kind,scopeKey]);
  let previous:string|null=null,count=0;
  for(const r of rows.rows){
   count++;
   const entry=this.row(r),checksum=sha(r.content);
   if(!SHA.test(entry.contentSha256)||checksum!==entry.contentSha256||
    entry.version!==count||entry.previousChain!==previous)
    throw new EvidenceIntegrityError('Evidence payload or version chain mismatch');
   const normalized=[previous??'',r.project_id,r.task_id,r.kind,r.scope_key,String(r.version),
    entry.contentSha256,r.canonical_metadata,r.run_id??'',r.actor_id].join('|');
   if(sha(normalized)!==entry.chainSha256)throw new EvidenceIntegrityError('Evidence hash chain mismatch');
   previous=entry.chainSha256;
  }
  return {count,head:previous};
 }
 async read(projectId:string,taskId:string,id:string,db:Db=this.pool):Promise<EvidenceEntry>{
  UuidSchema.parse(projectId);UuidSchema.parse(taskId);UuidSchema.parse(id);
  const row=await db.query<Row>(
   'SELECT * FROM evidence_entries WHERE project_id=$1 AND task_id=$2 AND id=$3',
   [projectId,taskId,id]);
  if(!row.rowCount)throw new EvidenceNotFound('Evidence not found');
  const item=row.rows[0]!;
  await this.verify(projectId,taskId,item.kind,item.scope_key,db);
  return this.row(item);
 }
 async list(projectId:string,taskId:string,kind:string,scopeKey:string):Promise<EvidenceEntry[]>{
  await this.verify(projectId,taskId,kind,scopeKey);
  const rows=await this.pool.query<Row>(
   'SELECT * FROM evidence_entries WHERE project_id=$1 AND task_id=$2 AND kind=$3 AND scope_key=$4 ORDER BY version',
   [projectId,taskId,kind,scopeKey]);
  return rows.rows.map(x=>this.row(x));
 }
}
