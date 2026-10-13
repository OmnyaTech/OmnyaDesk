import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  ProjectSchema, OfficeSchema, TaskSchema, type Project, type Office, type Task
} from '../../contracts/src/domain.ts';
import { decodeDomainEventV1, type VersionedDomainEventV1 } from '../../contracts/src/events.ts';

type RecordRow=Record<string,unknown>;
type NewProject={ownerId:string;name:string;repositoryRoot:string|null;template:'startup'|'accounting'|'custom'};
type NewTask={projectId:string;officeId:string;requestedBy:string;title:string;description:string};
const iso=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const projectFrom=(r:RecordRow):Project=>ProjectSchema.parse({
  id:r.id,ownerId:r.owner_id,name:r.name,repositoryRoot:r.repository_root,
  createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),
});
const officeFrom=(r:RecordRow):Office=>OfficeSchema.parse({
  id:r.id,projectId:r.project_id,name:r.name,template:r.template,createdAt:iso(r.created_at),
});
export const taskFrom=(r:RecordRow):Task=>TaskSchema.parse({
  id:r.id,projectId:r.project_id,officeId:r.office_id,requestedBy:r.requested_by,
  title:r.title,description:r.description,status:r.status,version:Number(r.version),
  currentRunId:r.current_run_id,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),
});
async function transaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>):Promise<T> {
 const c=await pool.connect();
 try {
  await c.query('BEGIN');
  const result=await work(c);
  await c.query('COMMIT');
  return result;
 } catch(e) {await c.query('ROLLBACK');throw e;}
 finally {c.release();}
}
export class PostgresOfficeRepository {
 readonly pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 async createProject(input:NewProject):Promise<{project:Project;office:Office}> {
  const id=randomUUID(),officeId=randomUUID(),now=new Date().toISOString();
  ProjectSchema.parse({id,ownerId:input.ownerId,name:input.name,repositoryRoot:input.repositoryRoot,createdAt:now,updatedAt:now});
  OfficeSchema.parse({id:officeId,projectId:id,name:'Default',template:input.template,createdAt:now});
  return transaction(this.pool,async c=>{
   const p=await c.query('INSERT INTO projects(id,owner_id,name,repository_root) VALUES($1,$2,$3,$4) RETURNING *',
    [id,input.ownerId,input.name.trim(),input.repositoryRoot]);
   const o=await c.query('INSERT INTO offices(id,project_id,name,template) VALUES($1,$2,$3,$4) RETURNING *',
    [officeId,id,'Default',input.template]);
   return {project:projectFrom(p.rows[0]),office:officeFrom(o.rows[0])};
  });
 }
 async getProject(projectId:string):Promise<Project|null> {
  const rows=await this.pool.query('SELECT * FROM projects WHERE id=$1',[projectId]);
  return rows.rowCount?projectFrom(rows.rows[0]):null;
 }
 async listProjects():Promise<Project[]> {
  const r=await this.pool.query('SELECT * FROM projects ORDER BY created_at ASC,id ASC LIMIT 500');
  return r.rows.map(projectFrom);
 }
 async createTask(input:NewTask):Promise<Task> {
  const id=randomUUID(),eventId=randomUUID(),now=new Date().toISOString();
  TaskSchema.parse({
   id,projectId:input.projectId,officeId:input.officeId,requestedBy:input.requestedBy,
   title:input.title,description:input.description,status:'created',version:1,
   currentRunId:null,createdAt:now,updatedAt:now,
  });
  return transaction(this.pool,async c=>{
   const t=await c.query(
    `INSERT INTO tasks(id,project_id,office_id,requested_by,title,description)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id,input.projectId,input.officeId,input.requestedBy,input.title.trim(),input.description]
   );
   const task=taskFrom(t.rows[0]);
   // Serialize event allocation until commit to avoid cursors skipping later commits.
   await c.query('SELECT pg_advisory_xact_lock(711133,5)');
   const e=await c.query<{sequence:string;occurred_at:Date}>(
    `INSERT INTO task_events(event_id,schema_version,project_id,office_id,task_id,run_id,
        actor_kind,actor_id,correlation_id,causation_id,source,type,payload)
      VALUES ($1,1,$2,$3,$4,NULL,'system','system',NULL,NULL,'api','task.created',$5::jsonb)
      RETURNING sequence, occurred_at`,
    [eventId,task.projectId,task.officeId,task.id,JSON.stringify({title:task.title,requestedBy:task.requestedBy})]
   );
   const event=decodeDomainEventV1({
    schemaVersion:1,eventId,sequence:Number(e.rows[0]?.sequence),occurredAt:iso(e.rows[0]?.occurred_at),
    projectId:task.projectId,officeId:task.officeId,taskId:task.id,runId:null,
    actor:{kind:'system',id:'system'},correlationId:null,causationId:null,
    source:'api',type:'task.created',payload:{title:task.title,requestedBy:task.requestedBy},
   });
   await c.query('INSERT INTO task_outbox(project_id,task_id,event_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
    [task.projectId,task.id,eventId,JSON.stringify(event)]);
   return task;
  });
 }
 async listTasks(projectId:string):Promise<Task[]> {
  const rows=await this.pool.query('SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500',[projectId]);
  return rows.rows.map(taskFrom);
 }
 async listEvents(projectId:string,afterSequence=0):Promise<VersionedDomainEventV1[]> {
  if(!Number.isSafeInteger(afterSequence)||afterSequence<0)throw new Error('Invalid event cursor');
  const rows=await this.pool.query(
   `SELECT * FROM task_events WHERE project_id=$1 AND sequence>$2
      ORDER BY sequence ASC LIMIT 500`,[projectId,afterSequence]
  );
  return rows.rows.map((r:RecordRow)=>decodeDomainEventV1({
   schemaVersion:Number(r.schema_version),
   eventId:r.event_id,sequence:Number(r.sequence),occurredAt:iso(r.occurred_at),
   projectId:r.project_id,officeId:r.office_id,taskId:r.task_id,runId:r.run_id,
   actor:r.actor_kind==='system'?{kind:'system',id:'system'}:{kind:r.actor_kind,id:r.actor_id},
   correlationId:r.correlation_id,causationId:r.causation_id,
   source:r.source,type:r.type,payload:r.payload,
  }));
 }
}
