import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {
  canTransitionTask,TaskSchema,TaskLifecycleStateSchema,UuidSchema,
  type Task
} from '../../contracts/src/domain.ts';
import {DomainActorSchema,decodeDomainEventV1,type VersionedDomainEventV1} from '../../contracts/src/events.ts';
import {taskFrom} from './repository.ts';

export class WorkflowConflict extends Error {readonly status=409;}
export class WorkflowNotFound extends Error {readonly status=404;}
export class WorkflowBadRequest extends Error {readonly status=400;}

const TransitionCommand=z.strictObject({
 projectId:UuidSchema,taskId:UuidSchema,commandKey:UuidSchema,
 expectedVersion:z.number().int().positive(),to:TaskLifecycleStateSchema,
 reason:z.string().max(2000).nullable(),
 actor:DomainActorSchema,
 source:z.enum(['api','cli','mcp','vscode','web','worker','system']),
});
export type TransitionCommand=z.infer<typeof TransitionCommand>;
export type TransitionResult={task:Task;event:VersionedDomainEventV1;replayed:boolean};
type Snapshot={task:Task;event:VersionedDomainEventV1};

function validateSnapshot(data:unknown):Snapshot{
 if(!data||typeof data!=='object')throw new Error('Corrupted command response');
 const obj=data as Record<string,unknown>;
 return {task:TaskSchema.parse(obj.task),event:decodeDomainEventV1(obj.event)};
}
const norm=(command:TransitionCommand)=>JSON.stringify({
 projectId:command.projectId,taskId:command.taskId,commandKey:command.commandKey,
 expectedVersion:command.expectedVersion,to:command.to,reason:command.reason,
 actor:command.actor,source:command.source
});
export class TaskOrchestrator {
 private readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async transition(raw:TransitionCommand):Promise<TransitionResult> {
  const c=TransitionCommand.parse(raw);
  const requestSha=createHash('sha256').update(norm(c)).digest('hex');
  const client=await this.pool.connect();
  try {
   await client.query('BEGIN');
   // Per-task row lock serializes competing writers, including duplicate commands.
   const rows=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[c.taskId,c.projectId]);
   if(!rows.rowCount)throw new WorkflowNotFound('Task not found for project');
   const previous=await client.query<{request_sha256:string;response_json:unknown}>(
    'SELECT request_sha256,response_json FROM task_commands WHERE project_id=$1 AND task_id=$2 AND command_key=$3',
    [c.projectId,c.taskId,c.commandKey]);
   if(previous.rowCount){
    if(previous.rows[0]!.request_sha256!==requestSha)throw new WorkflowConflict('Idempotency key reused with different command');
    const response=validateSnapshot(previous.rows[0]!.response_json);
    await client.query('COMMIT');
    return {...response,replayed:true};
   }
   const current=taskFrom(rows.rows[0]);
   if(current.version!==c.expectedVersion)throw new WorkflowConflict('Stale task version');
   if(!canTransitionTask(current.status,c.to))throw new WorkflowConflict('Illegal task transition');
   if(current.status==='awaiting_approval'&&['approved','changes_requested'].includes(c.to)&&c.actor.kind!=='human')
    throw new WorkflowConflict('Human identity required for approval or rejection');

   let runId=current.currentRunId;
   let newRunId:null|string=null;
   if(c.to==='queued'&&(current.status==='created'||current.status==='changes_requested')){
    runId=randomUUID();
    const attempt=await client.query<{attempt:string}>(
     'SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM task_runs WHERE project_id=$1 AND task_id=$2',
     [c.projectId,c.taskId]);
    await client.query(
     'INSERT INTO task_runs(id,project_id,task_id,attempt) VALUES($1,$2,$3,$4)',
     [runId,c.projectId,c.taskId,Number(attempt.rows[0]?.attempt)]);
    if(current.status==='changes_requested')newRunId=runId;
   }
   if(c.to==='queued'&&runId){
    // Same transaction as the FSM event/outbox; UNIQUE(run_id) prevents duplicate work.
    await client.query(
     `INSERT INTO worker_jobs(id,project_id,task_id,run_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(run_id) DO NOTHING`,
     [runId,c.projectId,c.taskId,runId]);
   }
   if(c.to==='cancelled'&&runId){
    // Cancellation of the task also cancels its queued work or revokes a running lease.
    await client.query(
     `UPDATE worker_jobs SET cancel_requested=true,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
      updated_at=now() WHERE run_id=$1 AND status IN ('queued','running')`,[runId]);
   }
   if(['approved','changes_requested'].includes(c.to)&&!runId)
    throw new WorkflowConflict('Approval requires a persistent run');
   const changed=await client.query(
    `UPDATE tasks SET status=$1,version=version+1,current_run_id=$2,updated_at=now()
      WHERE id=$3 AND project_id=$4 AND version=$5 RETURNING *`,
    [c.to,runId,c.taskId,c.projectId,c.expectedVersion]);
   if(changed.rowCount!==1)throw new WorkflowConflict('Concurrent task mutation');
   const task=taskFrom(changed.rows[0]);
   // Serializes event/outbox IDs with transaction commit order for safe cursor replay.
   await client.query('SELECT pg_advisory_xact_lock(711133,5)');
   const eventId=randomUUID();
   const payload={from:current.status,to:c.to,reason:c.reason,newRunId};
   const eventRow=await client.query<{sequence:string;occurred_at:Date}>(
    `INSERT INTO task_events(event_id,schema_version,project_id,office_id,task_id,run_id,
       actor_kind,actor_id,correlation_id,causation_id,source,type,payload)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,'task.status_changed',$10::jsonb)
     RETURNING sequence,occurred_at`,
    [eventId,task.projectId,task.officeId,task.id,runId,
     c.actor.kind,c.actor.id,c.commandKey,c.source,JSON.stringify(payload)]
   );
   const event=decodeDomainEventV1({
    schemaVersion:1,eventId,sequence:Number(eventRow.rows[0]?.sequence),
    occurredAt:eventRow.rows[0]!.occurred_at.toISOString(),
    projectId:task.projectId,officeId:task.officeId,taskId:task.id,runId,
    actor:c.actor,correlationId:c.commandKey,causationId:null,
    source:c.source,type:'task.status_changed',payload
   });
   await client.query(
    'INSERT INTO task_outbox(project_id,task_id,event_id,payload) VALUES($1,$2,$3,$4::jsonb)',
    [task.projectId,task.id,event.eventId,JSON.stringify(event)]);
   const result={task,event};
   await client.query(
    'INSERT INTO task_commands(project_id,task_id,command_key,request_sha256,response_json) VALUES($1,$2,$3,$4,$5::jsonb)',
    [c.projectId,c.taskId,c.commandKey,requestSha,JSON.stringify(result)]);
   await client.query('COMMIT');
   return {...result,replayed:false};
  }catch(error){
   await client.query('ROLLBACK');
   throw error;
  }finally{client.release();}
 }
 async listOutbox(projectId:string,afterId=0):Promise<{id:number;event:VersionedDomainEventV1}[]>{
  if(!Number.isSafeInteger(afterId)||afterId<0)throw new WorkflowBadRequest('Invalid outbox cursor');
  const rows=await this.pool.query(
   'SELECT id,payload FROM task_outbox WHERE project_id=$1 AND id>$2 ORDER BY id LIMIT 500',
   [projectId,afterId]);
  return rows.rows.map((row:{id:string;payload:unknown})=>({
   id:Number(row.id),event:decodeDomainEventV1(row.payload)
  }));
 }
}
