import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {TaskSchema,UuidSchema,type Task} from '../../contracts/src/domain.ts';
import {decodeDomainEventV1} from '../../contracts/src/events.ts';
import {type AuthPrincipal,ClientOriginSchema,IntakeChannelSchema} from './tokens.ts';
import {taskFrom} from './repository.ts';

export const IntakePayloadSchema=z.strictObject({
 officeId:UuidSchema,
 title:z.string().trim().min(1).max(140),
 description:z.string().max(4000),
});
export const IntakeCommandSchema=IntakePayloadSchema.extend({
 projectId:UuidSchema,
 idempotencyKey:UuidSchema,
});
export type IntakeCommand=z.input<typeof IntakeCommandSchema>;
export type IntakeReceipt={
 task:Task;eventId:string;idempotencyKey:string;
 origin:z.infer<typeof ClientOriginSchema>;
 channel:z.infer<typeof IntakeChannelSchema>;
 actor:{kind:'human'|'integration';id:string};
 acceptedAt:string;
};
export type IntakeResult=IntakeReceipt&{replayed:boolean};
export class IntakeConflict extends Error{readonly status=409;}
export class IntakeUnauthorized extends Error{readonly status=401;}
export class IntakeForbidden extends Error{readonly status=403;}
export class IntakeNotFound extends Error{readonly status=404;}

function parseReceipt(raw:unknown):IntakeReceipt{
 const data=raw as Record<string,unknown>;
 if(!data||typeof data!=='object')throw Error('Corrupt persisted intake receipt');
 const receipt=z.strictObject({
  task:TaskSchema,eventId:UuidSchema,idempotencyKey:UuidSchema,
  origin:ClientOriginSchema,channel:IntakeChannelSchema,
  actor:z.discriminatedUnion('kind',[
   z.strictObject({kind:z.literal('human'),id:UuidSchema}),
   z.strictObject({kind:z.literal('integration'),id:UuidSchema}),
  ]),
  acceptedAt:z.iso.datetime({offset:true})
 }).parse(data);
 return receipt;
}
export class TaskIntakeService{
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async create(raw:IntakeCommand,identity:AuthPrincipal):Promise<IntakeResult>{
  const cmd=IntakeCommandSchema.parse(raw);
  if(cmd.idempotencyKey==='00000000-0000-0000-0000-000000000000')
   throw new z.ZodError([{code:'custom',path:['idempotencyKey'],message:'Nil idempotency key is invalid'}]);
  if(identity.projectId!==cmd.projectId)throw new IntakeNotFound('Project not found');
  if(!identity.scopes.includes('tasks:create'))throw new IntakeForbidden('Insufficient scope');
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   // Lock the token row against simultaneous revocation. Never trust payload actor/source.
   const auth=await c.query(
    `SELECT project_id,subject_id,subject_kind,client_origin,intake_channel
       FROM api_tokens WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()
       AND 'tasks:create'=ANY(scopes) FOR SHARE`,[identity.tokenId]);
   if(!auth.rowCount)throw new IntakeUnauthorized('Authentication required');
   const principal=auth.rows[0]!;
   if(principal.project_id!==identity.projectId||principal.subject_id!==identity.subjectId||
      principal.subject_kind!==identity.kind)throw new IntakeUnauthorized('Authentication changed');
   const origin=ClientOriginSchema.parse(principal.client_origin);
   const channel=IntakeChannelSchema.parse(principal.intake_channel);
   const actor={kind:identity.kind,id:identity.subjectId} as const;
   const fingerprint=createHash('sha256').update(JSON.stringify({
    projectId:cmd.projectId,officeId:cmd.officeId,title:cmd.title,description:cmd.description,
    origin,channel,actor
   })).digest('hex');
   // All contenders for the same request key wait for a single committed result.
   // Hash collisions only serialize unrelated requests; the PK remains the authority.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77))',
    [cmd.projectId+':'+identity.subjectId+':'+cmd.idempotencyKey]);
   const previous=await c.query<{request_sha256:string;response_json:unknown}>(
    `SELECT request_sha256,response_json FROM task_intake_requests
      WHERE project_id=$1 AND subject_id=$2 AND idempotency_key=$3`,
    [cmd.projectId,identity.subjectId,cmd.idempotencyKey]);
   if(previous.rowCount){
    if(previous.rows[0]!.request_sha256!==fingerprint)
     throw new IntakeConflict('Idempotency key reused with different request');
    const receipt=parseReceipt(previous.rows[0]!.response_json);
    await c.query('COMMIT');
    return {...receipt,replayed:true};
   }
   return await this.persist(c,cmd,identity,origin,channel,actor,fingerprint);
  }catch(error){
   await c.query('ROLLBACK');
   throw error;
  }finally{c.release();}
 }
 private async persist(c:PoolClient,cmd:z.output<typeof IntakeCommandSchema>,principal:AuthPrincipal,
  origin:z.infer<typeof ClientOriginSchema>,channel:z.infer<typeof IntakeChannelSchema>,
  actor:{kind:'human'|'integration';id:string},fingerprint:string):Promise<IntakeResult>{
  const taskId=randomUUID(),eventId=randomUUID();
  const result=await c.query(
   `INSERT INTO tasks(id,project_id,office_id,requested_by,title,description)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
   [taskId,cmd.projectId,cmd.officeId,principal.subjectId,cmd.title,cmd.description]);
  const task=taskFrom(result.rows[0]);
  // Event and outbox IDs must be allocated in commit order for S08 cursor safety.
  await c.query('SELECT pg_advisory_xact_lock(711133,5)');
  const eventRow=await c.query<{sequence:string;occurred_at:Date}>(
   `INSERT INTO task_events(event_id,schema_version,project_id,office_id,task_id,run_id,
    actor_kind,actor_id,correlation_id,causation_id,source,type,payload)
    VALUES($1,1,$2,$3,$4,NULL,$5,$6,$7,NULL,$8,'task.created',$9::jsonb)
    RETURNING sequence,occurred_at`,
   [eventId,cmd.projectId,cmd.officeId,taskId,actor.kind,actor.id,cmd.idempotencyKey,
    channel,JSON.stringify({title:task.title,requestedBy:principal.subjectId})]
  );
  const event=decodeDomainEventV1({
   schemaVersion:1,eventId,sequence:Number(eventRow.rows[0]!.sequence),
   occurredAt:eventRow.rows[0]!.occurred_at.toISOString(),
   projectId:cmd.projectId,officeId:cmd.officeId,taskId,runId:null,
   actor,correlationId:cmd.idempotencyKey,causationId:null,
   source:channel,type:'task.created',payload:{title:task.title,requestedBy:principal.subjectId}
  });
  await c.query('INSERT INTO task_outbox(project_id,task_id,event_id,payload) VALUES($1,$2,$3,$4::jsonb)',
   [cmd.projectId,taskId,eventId,JSON.stringify(event)]);
  const receipt: IntakeReceipt={
   task,eventId,idempotencyKey:cmd.idempotencyKey,origin,channel,actor,
   acceptedAt:event.occurredAt
  };
  await c.query(
   `INSERT INTO task_intake_requests(project_id,task_id,office_id,subject_id,subject_kind,
    token_id,client_origin,intake_channel,idempotency_key,request_sha256,response_json,event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
   [cmd.projectId,taskId,cmd.officeId,principal.subjectId,principal.kind,principal.tokenId,
    origin,channel,cmd.idempotencyKey,fingerprint,JSON.stringify(receipt),eventId]
  );
  await c.query('COMMIT');
  return {...receipt,replayed:false};
 }
 async provenance(projectId:string,taskId:string):Promise<IntakeReceipt|null>{
  UuidSchema.parse(projectId);UuidSchema.parse(taskId);
  const r=await this.pool.query(
   'SELECT response_json FROM task_intake_requests WHERE project_id=$1 AND task_id=$2',
   [projectId,taskId]);
  return r.rowCount?parseReceipt(r.rows[0].response_json):null;
 }
}
