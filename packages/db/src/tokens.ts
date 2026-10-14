import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {UuidSchema} from '../../contracts/src/domain.ts';

export const ApiScopeSchema=z.enum(['projects:read','tasks:read','tasks:create','tasks:transition','events:read','files:write','git:propose','git:review','git:integrate']);
export type ApiScope=z.infer<typeof ApiScopeSchema>;
export const ClientOriginSchema=z.enum(['chatgpt','desktop_commander','codex','vscode','web','cli','other']);
export const IntakeChannelSchema=z.enum(['api','mcp']);
export type ClientOrigin=z.infer<typeof ClientOriginSchema>;
export type IntakeChannel=z.infer<typeof IntakeChannelSchema>;
export type AuthPrincipal={tokenId:string;projectId:string;subjectId:string;kind:'human'|'integration';scopes:readonly ApiScope[];origin:ClientOrigin;channel:IntakeChannel};
const TokenInput=z.strictObject({
 projectId:UuidSchema,subjectId:UuidSchema,
 kind:z.enum(['human','integration']),
 scopes:z.array(ApiScopeSchema).min(1).max(8),
 expiresInHours:z.number().int().min(1).max(720),
 origin:ClientOriginSchema.default('cli'),
 channel:IntakeChannelSchema.default('api'),
});
const TOKEN=/^odt_[a-f0-9]{64}$/;
export class TokenStore {
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async provision(raw:z.input<typeof TokenInput>):Promise<{id:string;secret:string;expiresAt:string}>{
  const input=TokenInput.parse(raw);
  if(new Set(input.scopes).size!==input.scopes.length)throw Error('Duplicate scopes');
  const id=randomUUID(),secret='odt_'+randomBytes(32).toString('hex');
  const digest=createHash('sha256').update(secret).digest('hex');
  const expiresAt=new Date(Date.now()+input.expiresInHours*3600000).toISOString();
  await this.pool.query(
   `INSERT INTO api_tokens(id,project_id,subject_id,subject_kind,secret_sha256,scopes,expires_at,client_origin,intake_channel)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
   [id,input.projectId,input.subjectId,input.kind,digest,input.scopes,expiresAt,input.origin,input.channel]);
  return {id,secret,expiresAt};
 }
 async authenticate(header:unknown):Promise<AuthPrincipal|null>{
  if(typeof header!=='string')return null;
  const match=/^Bearer (odt_[a-f0-9]{64})$/.exec(header);
  if(!match||!TOKEN.test(match[1]!))return null;
  const digest=createHash('sha256').update(match[1]!).digest('hex');
  const data=await this.pool.query(
   `SELECT id,project_id,subject_id,subject_kind,scopes,client_origin,intake_channel FROM api_tokens
     WHERE secret_sha256=$1 AND revoked_at IS NULL AND expires_at>now()`,[digest]);
  if(!data.rowCount)return null;
  const row=data.rows[0];
  return {tokenId:row.id,projectId:row.project_id,subjectId:row.subject_id,kind:row.subject_kind,
   scopes:row.scopes as ApiScope[],origin:ClientOriginSchema.parse(row.client_origin),channel:IntakeChannelSchema.parse(row.intake_channel)};
 }
 async revoke(id:string):Promise<boolean>{
  UuidSchema.parse(id);
  const row=await this.pool.query(
   'UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id',[id]);
  return row.rowCount===1;
 }
}
