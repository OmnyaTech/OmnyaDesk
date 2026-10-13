import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import swagger from '@fastify/swagger';
import {ZodError} from 'zod';
import type {Pool} from 'pg';
import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../../../packages/db/src/repository.ts';
import {TaskOrchestrator,WorkflowBadRequest,WorkflowConflict,WorkflowNotFound} from '../../../packages/db/src/orchestration.ts';
import {TokenStore,type AuthPrincipal,type ApiScope} from '../../../packages/db/src/tokens.ts';
import type {TaskLifecycleState} from '../../../packages/contracts/src/domain.ts';
import {ProjectSseHub,parseSseCursor} from './sse.ts';
import {ResourceScheduler,SchedulerConflict,SchedulerBadRequest,SchedulerNotFound} from '../../../packages/db/src/scheduler.ts';
import {TaskIntakeService,IntakeConflict,IntakeUnauthorized,IntakeForbidden,IntakeNotFound} from '../../../packages/db/src/intake.ts';
import {GitIntegrationQueue,IntegrationConflict,IntegrationForbidden,IntegrationNotFound} from '../../../packages/db/src/git-integration.ts';
import {GitValidationError} from '../../../packages/db/src/git-driver.ts';

const uuid={type:'string',format:'uuid'} as const;
const projectParams={type:'object',required:['projectId'],additionalProperties:false,
 properties:{projectId:uuid}} as const;
const taskParams={type:'object',required:['projectId','taskId'],additionalProperties:false,
 properties:{projectId:uuid,taskId:uuid}} as const;
const cursor={type:'object',additionalProperties:false,
 properties:{after:{type:'integer',minimum:0,maximum:9007199254740991}}} as const;
const errorResponse={type:'object',properties:{error:{type:'string'}}} as const;
const secured=(scope:ApiScope)=>({
 description:'Requires project-scoped Bearer token with '+scope,
 security:[{bearerToken:[]}],
 response:{401:errorResponse,403:errorResponse,404:errorResponse}
});
const httpError=(status:number,message:string)=>Object.assign(new Error(message),{statusCode:status});

export async function buildPersistentApi(pool:Pool):Promise<FastifyInstance>{
 const api=Fastify({logger:false,bodyLimit:8192,ajv:{customOptions:{removeAdditional:false}}});
 const repo=new PostgresOfficeRepository(pool),flows=new TaskOrchestrator(pool),tokens=new TokenStore(pool);
 const hub=new ProjectSseHub(flows,tokens),intake=new TaskIntakeService(pool),scheduler=new ResourceScheduler(pool);
 const integrations=new GitIntegrationQueue(pool);
 await api.register(swagger,{openapi:{
  info:{title:'OmnyaDesk Local API',version:'1.0.0-s11',description:'Local PostgreSQL API; no public exposure before security/release gates.'},
  components:{securitySchemes:{bearerToken:{type:'http',scheme:'bearer',bearerFormat:'opaque'}}},
 }});
 // Global guard: every /v1 operation except the diagnostic status requires a scoped bearer.
 // This protects future routes from inadvertently omitting a per-route authorization hook.
 api.addHook('onRequest',async(request)=>{
  const path=request.url.split('?')[0];
  if(!path?.startsWith('/v1/')||path==='/v1/status')return;
  const principal=await tokens.authenticate(request.headers.authorization);
  if(!principal)throw httpError(401,'Authentication required');
  (request as FastifyRequest & {principal?:AuthPrincipal}).principal=principal;
 });
 const guard=(req:FastifyRequest,scope:ApiScope,projectId?:string):AuthPrincipal=>{
  const principal=(req as FastifyRequest & {principal?:AuthPrincipal}).principal;
  if(!principal)throw httpError(401,'Authentication required');
  if(!principal.scopes.includes(scope))throw httpError(403,'Insufficient scope');
  if(projectId&&principal.projectId!==projectId)throw httpError(404,'Project not found');
  return principal;
 };
 api.setErrorHandler((error,req,res)=>{
  const status=(error as {statusCode?:number}).statusCode;
  if(status===401||status===403||status===404||status===503)
   return res.code(status).send({error:status===404?'Not found':status===401?'Authentication required':status===503?'Too many active streams':'Insufficient scope'});
  if(error instanceof ZodError||status===400||error instanceof SyntaxError)return res.code(400).send({error:'Invalid request'});
  if(error instanceof IntegrationConflict||error instanceof IntegrationForbidden||error instanceof IntegrationNotFound)
   return res.code(error.status).send({error:error.status===404?'Not found':error.status===403?'Insufficient scope':error.message});
  if(error instanceof GitValidationError)return res.code(409).send({error:'Git candidate or integration repository validation failed'});
  if(error instanceof SchedulerConflict||error instanceof SchedulerBadRequest||error instanceof SchedulerNotFound)
   return res.code(error.status).send({error:error.status===404?'Not found':error.message});
  if(error instanceof IntakeConflict||error instanceof IntakeUnauthorized||error instanceof IntakeForbidden||error instanceof IntakeNotFound)
   return res.code(error.status).send({error:error.status===404?'Not found':error.status===401?'Authentication required':error.status===403?'Insufficient scope':error.message});
  if(error instanceof WorkflowBadRequest||error instanceof WorkflowConflict||error instanceof WorkflowNotFound)
   return res.code(error.status).send({error:error.message});
  const db=error as {code?:string};
  if(['23503','23505','23514'].includes(db.code??''))return res.code(409).send({error:'Database constraint violation'});
  // Never include SQL errors, raw tokens, request headers or stack traces in responses.
  return res.code(500).send({error:'Internal server error'});
 });
 api.get('/openapi.json',{schema:{hide:true}},async()=>api.swagger());
 api.get('/v1/status',{schema:{tags:['system'],response:{200:{type:'object',properties:{ok:{type:'boolean'},mode:{type:'string'}}}}}},
  async()=>({ok:true,mode:'persistent-postgres-authenticated'}));
 api.get('/v1/projects',{schema:{...secured('projects:read'),tags:['projects']}},
  async(req)=>{
   const user=guard(req,'projects:read');
   const project=await repo.getProject(user.projectId);
   return {projects:project?[project]:[]};
  });
 api.get<{Params:{projectId:string}}>('/v1/projects/:projectId',{
   schema:{...secured('projects:read'),params:projectParams,tags:['projects']}},
  async(req)=>{
   guard(req,'projects:read',req.params.projectId);
   const project=await repo.getProject(req.params.projectId);
   if(!project)throw httpError(404,'Not found');
   return {project};
  });
 api.get<{Params:{projectId:string}}>('/v1/projects/:projectId/tasks',{
  schema:{...secured('tasks:read'),params:projectParams,tags:['tasks']}},
  async(req)=>{
   guard(req,'tasks:read',req.params.projectId);
   return {tasks:await repo.listTasks(req.params.projectId)};
  });
 const intakeSchema={...secured('tasks:create'),params:projectParams,tags:['intake'],
  description:'Single authenticated task ingress. Supply Idempotency-Key UUID; origin and actor come from the token.',
  headers:{type:'object',required:['idempotency-key'],properties:{'idempotency-key':uuid}},
  body:{type:'object',required:['officeId','title','description'],additionalProperties:false,
   properties:{officeId:uuid,title:{type:'string',minLength:1,maxLength:140},
    description:{type:'string',maxLength:4000}}}} as const;
 const createThroughIntake=async(req:FastifyRequest<{Params:{projectId:string};Body:{officeId:string;title:string;description:string}}>,reply:import('fastify').FastifyReply)=>{
  const actor=guard(req,'tasks:create',req.params.projectId);
  const key=req.headers['idempotency-key'];
  if(typeof key!=='string')throw httpError(400,'Idempotency-Key UUID required');
  const result=await intake.create({
   projectId:req.params.projectId,officeId:req.body.officeId,
   title:req.body.title,description:req.body.description,idempotencyKey:key
  },actor);
  return reply.code(result.replayed?200:201).send(result);
 };
 // Compatibility path deliberately shares EXACTLY the same intake service and key semantics.
 api.post<{Params:{projectId:string};Body:{officeId:string;title:string;description:string}}>(
  '/v1/projects/:projectId/tasks',{schema:intakeSchema},createThroughIntake);
 api.post<{Params:{projectId:string};Body:{officeId:string;title:string;description:string}}>(
  '/v1/projects/:projectId/intake',{schema:intakeSchema},createThroughIntake);
 api.get<{Params:{projectId:string;taskId:string}}>('/v1/projects/:projectId/tasks/:taskId/intake',{
  schema:{...secured('tasks:read'),params:taskParams,tags:['intake']}},
  async(req)=>{
   guard(req,'tasks:read',req.params.projectId);
   const receipt=await intake.provenance(req.params.projectId,req.params.taskId);
   if(!receipt)throw httpError(404,'Not found');
   return {provenance:{taskId:receipt.task.id,eventId:receipt.eventId,
    origin:receipt.origin,channel:receipt.channel,actor:receipt.actor,
    idempotencyKey:receipt.idempotencyKey,acceptedAt:receipt.acceptedAt}};
  });
 const schedulerBody={type:'object',required:['resources'],additionalProperties:false,
  properties:{
   priority:{type:'integer',minimum:0,maximum:10},
   resources:{type:'array',minItems:1,maxItems:16,items:{type:'object',required:['key','mode'],
    additionalProperties:false,properties:{key:{type:'string',minLength:1,maxLength:270},
     mode:{type:'string',enum:['read','write']}}}},
   dependsOn:{type:'array',maxItems:32,items:uuid}
  }} as const;
 const leaseBody={type:'object',required:['leaseToken','fence'],additionalProperties:false,
  properties:{leaseToken:uuid,fence:{type:'integer',minimum:1}}} as const;
 api.post<{Params:{projectId:string;taskId:string};Body:{
  priority?:number;resources:{key:string;mode:'read'|'write'}[];dependsOn?:string[]
 }}>('/v1/projects/:projectId/tasks/:taskId/schedule',{
  schema:{...secured('tasks:transition'),params:taskParams,body:schedulerBody,tags:['scheduler']}},
  async(req,reply)=>{
   guard(req,'tasks:transition',req.params.projectId);
   const registered=await scheduler.register({projectId:req.params.projectId,taskId:req.params.taskId,...req.body});
   return reply.code(201).send({schedule:registered});
  });
 api.get<{Params:{projectId:string;taskId:string}}>('/v1/projects/:projectId/tasks/:taskId/schedule',{
  schema:{...secured('tasks:read'),params:taskParams,tags:['scheduler']}},
  async(req)=>{
   guard(req,'tasks:read',req.params.projectId);
   const plan=await scheduler.get(req.params.projectId,req.params.taskId);
   if(!plan)throw httpError(404,'Not found');
   return {schedule:plan};
  });
 api.post<{Params:{projectId:string};Body:{ttlMs?:number}}>('/v1/projects/:projectId/scheduler/claim',{
  schema:{...secured('tasks:transition'),params:projectParams,tags:['scheduler'],
   body:{type:'object',additionalProperties:false,
    properties:{ttlMs:{type:'integer',minimum:250,maximum:120000}}}}},
  async(req)=>{
   const actor=guard(req,'tasks:transition',req.params.projectId);
   return {claim:await scheduler.claim(req.params.projectId,actor.subjectId,req.body.ttlMs??30000)};
  });
 api.post<{Params:{projectId:string;taskId:string};Body:{leaseToken:string;fence:number;ttlMs:number}}>(
 '/v1/projects/:projectId/tasks/:taskId/schedule/heartbeat',{
  schema:{...secured('tasks:transition'),params:taskParams,tags:['scheduler'],
   body:{type:'object',required:['leaseToken','fence','ttlMs'],additionalProperties:false,
    properties:{...leaseBody.properties,ttlMs:{type:'integer',minimum:250,maximum:120000}}}}},
  async(req)=>{
   const actor=guard(req,'tasks:transition',req.params.projectId);
   const until=await scheduler.heartbeat(req.params.projectId,req.params.taskId,actor.subjectId,
    req.body.leaseToken,req.body.fence,req.body.ttlMs);
   if(!until)throw new SchedulerConflict('Stale lease');
   return {leaseUntil:until};
  });
 api.post<{Params:{projectId:string;taskId:string};Body:{leaseToken:string;fence:number}}>(
 '/v1/projects/:projectId/tasks/:taskId/schedule/complete',{
  schema:{...secured('tasks:transition'),params:taskParams,tags:['scheduler'],body:leaseBody}},
  async(req)=>{
   const actor=guard(req,'tasks:transition',req.params.projectId);
   const completed=await scheduler.complete(req.params.projectId,req.params.taskId,actor.subjectId,
    req.body.leaseToken,req.body.fence);
   if(!completed)throw new SchedulerConflict('Stale lease');
   return {completed};
  });
 api.post<{Params:{projectId:string;taskId:string}}>('/v1/projects/:projectId/tasks/:taskId/schedule/cancel',{
  schema:{...secured('tasks:transition'),params:taskParams,tags:['scheduler']}},
  async(req)=>{
   guard(req,'tasks:transition',req.params.projectId);
   return {cancelled:await scheduler.cancel(req.params.projectId,req.params.taskId)};
  });
 const integrationParams={type:'object',required:['projectId','id'],additionalProperties:false,
  properties:{projectId:uuid,id:uuid}} as const;
 const sha={type:'string',pattern:'^[a-f0-9]{40}$'} as const;
 const hash={type:'string',pattern:'^[a-f0-9]{64}$'} as const;
 api.post<{Params:{projectId:string};Body:{
  taskId:string;candidateRef:string;candidateSha:string;baseSha:string;priority?:number
 }}>('/v1/projects/:projectId/git/integrations',{
  schema:{...secured('git:propose'),params:projectParams,tags:['git-integrations'],
   body:{type:'object',required:['taskId','candidateRef','candidateSha','baseSha'],additionalProperties:false,
    properties:{taskId:uuid,candidateRef:{type:'string',minLength:1,maxLength:180},
     candidateSha:sha,baseSha:sha,priority:{type:'integer',minimum:0,maximum:10}}}}},
  async(req,reply)=>{
   const actor=guard(req,'git:propose',req.params.projectId);
   const result=await integrations.submit({projectId:req.params.projectId,...req.body},actor);
   return reply.code(201).send(result);
  });
 api.post<{Params:{projectId:string;id:string}}>('/v1/projects/:projectId/git/integrations/:id/prepare',{
  schema:{...secured('git:integrate'),params:integrationParams,tags:['git-integrations']}},
  async(req)=>{
   const actor=guard(req,'git:integrate',req.params.projectId);
   return integrations.prepare(req.params.projectId,req.params.id,actor);
  });
 api.post<{Params:{projectId:string;id:string};Body:{reviewHash:string}}>(
  '/v1/projects/:projectId/git/integrations/:id/approve',{
  schema:{...secured('git:review'),params:integrationParams,tags:['git-integrations'],
   body:{type:'object',required:['reviewHash'],additionalProperties:false,
    properties:{reviewHash:hash}}}},
  async(req)=>{
   const actor=guard(req,'git:review',req.params.projectId);
   return integrations.approve(req.params.projectId,req.params.id,req.body.reviewHash,actor);
  });
 api.post<{Params:{projectId:string;id:string}}>('/v1/projects/:projectId/git/integrations/:id/integrate',{
  schema:{...secured('git:integrate'),params:integrationParams,tags:['git-integrations']}},
  async(req,reply)=>{
   const actor=guard(req,'git:integrate',req.params.projectId);
   const result=await integrations.integrate(req.params.projectId,req.params.id,actor);
   return reply.code(result.state==='stale'?409:200).send(result);
  });
 api.get<{Params:{projectId:string;id:string}}>('/v1/projects/:projectId/git/integrations/:id',{
  schema:{...secured('tasks:read'),params:integrationParams,tags:['git-integrations']}},
  async(req)=>{
   const actor=guard(req,'tasks:read',req.params.projectId);
   return {integration:await integrations.get(req.params.projectId,req.params.id,actor)};
  });
 api.get<{Params:{projectId:string}}>('/v1/projects/:projectId/git/integrations',{
  schema:{...secured('tasks:read'),params:projectParams,tags:['git-integrations']}},
  async(req)=>{
   const actor=guard(req,'tasks:read',req.params.projectId);
   return {integrations:await integrations.list(req.params.projectId,actor)};
  });
 api.get<{Params:{projectId:string};Querystring:{after?:number}}>('/v1/projects/:projectId/events',{
  schema:{...secured('events:read'),params:projectParams,querystring:cursor,tags:['events']}},
  async(req)=>{
   guard(req,'events:read',req.params.projectId);
   return {events:await repo.listEvents(req.params.projectId,req.query.after??0)};
  });
 api.get<{Params:{projectId:string};Querystring:{after?:number}}>('/v1/projects/:projectId/outbox',{
  schema:{...secured('events:read'),params:projectParams,querystring:cursor,tags:['events']}},
  async(req)=>{
   guard(req,'events:read',req.params.projectId);
   return {messages:await flows.listOutbox(req.params.projectId,req.query.after??0)};
  });
 api.get<{Params:{projectId:string};Querystring:{after?:number}}>('/v1/projects/:projectId/stream',{
  schema:{...secured('events:read'),params:projectParams,querystring:cursor,tags:['events'],
   description:'Authenticated Server-Sent Events with outbox ID replay (Last-Event-ID or after query). Requires fetch streaming with Authorization header.',
   response:{200:{description:'text/event-stream'},401:errorResponse,403:errorResponse,404:errorResponse,400:errorResponse,503:errorResponse}}},
  (req,reply)=>{
   const actor=guard(req,'events:read',req.params.projectId);
   const lastId=parseSseCursor(req.headers['last-event-id'],req.query.after);
   hub.stream(req,reply,actor,lastId);
  });
 api.post<{Params:{projectId:string;taskId:string};Body:{
  commandKey:string;expectedVersion:number;to:TaskLifecycleState;reason:string|null
 }}>('/v1/projects/:projectId/tasks/:taskId/transitions',{
  schema:{...secured('tasks:transition'),params:taskParams,tags:['tasks'],
   body:{type:'object',required:['commandKey','expectedVersion','to','reason'],additionalProperties:false,
    properties:{commandKey:uuid,expectedVersion:{type:'integer',minimum:1},
     to:{type:'string',enum:['queued','planning','implementing','testing','reviewing',
      'awaiting_approval','approved','changes_requested','retrying','blocked','failed','cancelled','expired']},
     reason:{anyOf:[{type:'string',maxLength:2000},{type:'null'}]}}}}},
 async(req)=>{
  const actor=guard(req,'tasks:transition',req.params.projectId);
  // S15 will bind approval to authenticated human + immutable reviewed diff.
  if(req.body.to==='approved'||req.body.to==='changes_requested')
    throw httpError(403,'Approval gated until S15');
  return flows.transition({
   ...req.body,projectId:req.params.projectId,taskId:req.params.taskId,
   actor:{kind:actor.kind,id:actor.subjectId},source:'api'
  });
 });
 await api.ready();
 return api;
}

export async function servePersistentApi():Promise<void>{
 const host=process.env.OMNYA_HOST??'127.0.0.1';
 if(host!=='127.0.0.1'&&host!=='::1')throw Error('S07 API is LOCAL ONLY; public bind prohibited');
 const port=Number(process.env.OMNYA_PORT??4317);
 const pool=createPool(process.env.DATABASE_URL??'');
 await runMigrations(pool);
 const api=await buildPersistentApi(pool);
 const close=async()=>{await api.close();await pool.end();};
 process.once('SIGTERM',()=>{void close();});
 process.once('SIGINT',()=>{void close();});
 try{await api.listen({port,host});console.log('OmnyaDesk authenticated local Fastify API listening on loopback');}
 catch(e){await close();throw e;}
}
