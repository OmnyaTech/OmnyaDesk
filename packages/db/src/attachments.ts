import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import type {Pool} from 'pg';

export const MAX_ATTACHMENT_BYTES=1_048_576;
export const MAX_ATTACHMENTS_PER_TASK=20;
export const MAX_PROJECT_BYTES=32*MAX_ATTACHMENT_BYTES;
const FILE=/^[^\\/<>:"|?*]{1,120}$/u;
const hasControls=(s:string)=>Array.from(s).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);
const formats={
 'image/png':'.png','image/jpeg':'.jpg',
 'application/pdf':'.pdf','text/plain':'.txt','text/x-diff':'.diff'
} as const;
export type AttachmentMime=keyof typeof formats;
export type UploadInput={filename:string;mimeType:string;dataBase64:string};
export type AttachmentMeta={
 id:string;taskId:string;filename:string;mimeType:AttachmentMime;
 sizeBytes:number;sha256:string;createdAt:string
};
export class AttachmentInvalid extends Error{status=400;}
export class AttachmentLimit extends Error{status=413;}
export class AttachmentNotFound extends Error{status=404;}
const utf8=new TextDecoder('utf-8',{fatal:true});
export function inspectUpload(input:UploadInput){
 const {filename,mimeType,dataBase64}=input;
 if(typeof filename!=='string'||!FILE.test(filename)||hasControls(filename)||filename!==filename.trim()||
    filename.startsWith('.')||filename.endsWith('.')||filename.includes('..'))
  throw new AttachmentInvalid('Invalid filename');
 if(!(mimeType in formats))throw new AttachmentInvalid('Unsupported MIME');
 const mime=mimeType as AttachmentMime;
 const ext=filename.slice(filename.lastIndexOf('.')).toLowerCase();
 if(ext!==formats[mime] && !(mime==='image/jpeg'&&ext==='.jpeg') &&
    !(mime==='text/x-diff'&&ext==='.patch'))throw new AttachmentInvalid('MIME/extension mismatch');
 if(typeof dataBase64!=='string'||dataBase64.length<4||
    dataBase64.length>Math.ceil(MAX_ATTACHMENT_BYTES/3)*4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64))
  throw new AttachmentLimit('File is empty, malformed or too large');
 const data=Buffer.from(dataBase64,'base64');
 if(!data.length||data.length>MAX_ATTACHMENT_BYTES)throw new AttachmentLimit('Size limit is 1 MiB');
 if(data.toString('base64')!==dataBase64)throw new AttachmentInvalid('Noncanonical base64');
 if(data.subarray(0,2).toString()==='MZ'||data.subarray(0,4).toString('hex')==='7f454c46'||
    data.subarray(0,4).toString()==='PK\x03\x04'||data.subarray(0,2).toString()==='#!')
  throw new AttachmentInvalid('Executable or archive content forbidden');
 if(mime==='image/png'&&!(data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&
    data.length>=24&&data.subarray(12,16).toString()==='IHDR'))
  throw new AttachmentInvalid('Invalid PNG signature');
 if(mime==='image/jpeg'&&!(data.length>=4&&data[0]===0xff&&data[1]===0xd8&&
    data[data.length-2]===0xff&&data[data.length-1]===0xd9))
  throw new AttachmentInvalid('Invalid JPEG signature');
 if(mime==='application/pdf'){
  if(!data.subarray(0,8).toString('latin1').startsWith('%PDF-')||
     !data.subarray(Math.max(0,data.length-128)).toString('latin1').includes('%%EOF')||
     /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia|XFA|AcroForm)\b/i.test(data.toString('latin1')))
   throw new AttachmentInvalid('PDF must be passive and well formed');
 }
 if(mime.startsWith('text/')){
  let decoded:string;
  try{decoded=utf8.decode(data);}catch{throw new AttachmentInvalid('Invalid UTF-8 text');}
  if(Array.from(decoded).some(c=>{const n=c.charCodeAt(0);return n===0||n===127||(n<32&&n!==9&&n!==10&&n!==13);}))throw new AttachmentInvalid('Binary text forbidden');
  if(decoded.length>MAX_ATTACHMENT_BYTES)throw new AttachmentLimit('Text too large');
  if(mime==='text/x-diff'&&!(/^(?:diff --git |--- |\+\+\+ |@@ |Index: |\*\*\* )/m.test(decoded)))
   throw new AttachmentInvalid('Diff must use a recognized textual diff format');
 }
 return {filename,mimeType:mime,data,sha256:createHash('sha256').update(data).digest('hex')};
}
type DbRow={id:string;task_id:string;filename:string;mime_type:AttachmentMime;size_bytes:number;sha256:string;created_at:Date;data?:Buffer};
const map=(r:DbRow):AttachmentMeta=>({id:r.id,taskId:r.task_id,filename:r.filename,
 mimeType:r.mime_type,sizeBytes:r.size_bytes,sha256:r.sha256,createdAt:new Date(r.created_at).toISOString()});
export class PrivateAttachments{
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async upload(projectId:string,taskId:string,subjectId:string,input:UploadInput){
  const checked=inspectUpload(input),c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   // Serializes concurrent project uploads to enforce quotas across simultaneous requests.
   await c.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
   const task=await c.query('SELECT 1 FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
   if(!task.rowCount)throw new AttachmentNotFound('Task not found');
   const quota=await c.query<{count:string;bytes:string}>(`SELECT
    count(*) FILTER(WHERE task_id=$2)::text AS count,
    coalesce(sum(size_bytes),0)::text AS bytes FROM task_attachments WHERE project_id=$1`,[projectId,taskId]);
   if(Number(quota.rows[0]?.count)>=MAX_ATTACHMENTS_PER_TASK||
      Number(quota.rows[0]?.bytes)+checked.data.length>MAX_PROJECT_BYTES)
    throw new AttachmentLimit('Attachment quota reached');
   const id=randomUUID();
   const result=await c.query<DbRow>(`INSERT INTO task_attachments
    (id,project_id,task_id,uploaded_by,filename,mime_type,data,size_bytes,sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id,task_id,filename,mime_type,size_bytes,sha256,created_at`,
    [id,projectId,taskId,subjectId,checked.filename,checked.mimeType,
     checked.data,checked.data.length,checked.sha256]);
   await c.query('COMMIT');
   return map(result.rows[0]!);
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async list(projectId:string,taskId:string){
  const valid=await this.pool.query('SELECT 1 FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
  if(!valid.rowCount)throw new AttachmentNotFound('Task not found');
  const rows=await this.pool.query<DbRow>(`SELECT id,task_id,filename,mime_type,size_bytes,sha256,created_at
   FROM task_attachments WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20`,[projectId,taskId]);
  return rows.rows.map(map);
 }
 async get(projectId:string,taskId:string,id:string){
  const rows=await this.pool.query<DbRow>(`SELECT id,task_id,filename,mime_type,size_bytes,sha256,created_at,data
   FROM task_attachments WHERE project_id=$1 AND task_id=$2 AND id=$3`,[projectId,taskId,id]);
  const r=rows.rows[0];if(!r?.data)throw new AttachmentNotFound('Attachment not found');
  const digest=createHash('sha256').update(r.data).digest('hex');
  if(digest!==r.sha256||r.data.length!==r.size_bytes)throw new AttachmentInvalid('Attachment integrity mismatch');
  return {attachment:map(r),dataBase64:r.data.toString('base64')};
 }
}
