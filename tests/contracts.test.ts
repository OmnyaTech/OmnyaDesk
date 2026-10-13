import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OFFICE_TEMPLATES, TASK_LIFECYCLE_STATES, TASK_TRANSITIONS, TASK_RUN_STATES,
  ProjectSchema, OfficeSchema, DepartmentSchema, AgentSchema, SkillSchema,
  TaskSchema, TaskRunSchema, ApprovalSchema, ArtifactSchema, ProviderPolicySchema,
  canTransitionTask,
} from '../packages/contracts/src/domain.ts';
import { decodeDomainEventV1, DOMAIN_EVENT_SCHEMA_VERSION } from '../packages/contracts/src/events.ts';

const ids = {
  project: 'a0000000-0000-4000-8000-000000000001',
  office: 'a0000000-0000-4000-8000-000000000002',
  owner: 'a0000000-0000-4000-8000-000000000003',
  department: 'a0000000-0000-4000-8000-000000000004',
  agent: 'a0000000-0000-4000-8000-000000000005',
  skill: 'a0000000-0000-4000-8000-000000000006',
  task: 'a0000000-0000-4000-8000-000000000007',
  run: 'a0000000-0000-4000-8000-000000000008',
  approval: 'a0000000-0000-4000-8000-000000000009',
  event: 'a0000000-0000-4000-8000-00000000000a',
  correlation: 'a0000000-0000-4000-8000-00000000000b',
};
const at = '2026-10-11T20:30:00.000Z';
const hash = 'a'.repeat(64);
const fixture = (extra:Record<string, unknown>) => ({
  schemaVersion: 1, eventId: ids.event, sequence: 1, occurredAt: at,
  projectId: ids.project, officeId: ids.office, taskId: ids.task,
  runId: ids.run, actor: {kind:'system', id:'system'},
  correlationId: ids.correlation, causationId: null, source: 'system',
  ...extra,
  payload: extra.payload as Record<string, unknown>,
});

test('dominio define startups, escritorio contabil e customizavel', () => {
  assert.deepEqual(OFFICE_TEMPLATES, ['startup','accounting','custom']);
  assert.equal(OfficeSchema.parse({id:ids.office,projectId:ids.project,name:'Contabil',template:'accounting',createdAt:at}).template,'accounting');
  assert.equal(ProjectSchema.parse({id:ids.project,ownerId:ids.owner,name:'Meu Projeto',repositoryRoot:null,createdAt:at,updatedAt:at}).ownerId,ids.owner);
  assert.equal(DepartmentSchema.parse({id:ids.department,projectId:ids.project,officeId:ids.office,code:'qa',name:'Qualidade',enabled:true}).code,'qa');
  assert.equal(SkillSchema.parse({id:ids.skill,code:'typescript',version:1,description:'Typescript',enabled:true}).version,1);
});

test('papel do agente e modelo sao identidades independentes', () => {
  const policy={mode:'automatic',preferredProvider:null,allowedProviders:['codex','local']};
  assert.deepEqual(ProviderPolicySchema.parse(policy).allowedProviders,['codex','local']);
  assert.equal(AgentSchema.parse({
    id:ids.agent,projectId:ids.project,officeId:ids.office,departmentId:ids.department,
    displayName:'Arquiteto',role:'architect',skillIds:[ids.skill],providerPolicy:policy,enabled:true,
  }).role,'architect');
  assert.equal(ProviderPolicySchema.safeParse({mode:'fixed',preferredProvider:'claude',allowedProviders:['codex']}).success,false);
  assert.equal(ProviderPolicySchema.safeParse({mode:'automatic',preferredProvider:null,allowedProviders:['codex','codex']}).success,false);
});

test('mapa de transicoes contem apenas estados conhecidos e impede loops implicitos',()=>{
  assert.equal(TASK_LIFECYCLE_STATES.length,new Set(TASK_LIFECYCLE_STATES).size);
  for(const state of TASK_LIFECYCLE_STATES){
    assert.ok(Object.hasOwn(TASK_TRANSITIONS,state));
    assert.equal(new Set(TASK_TRANSITIONS[state]).size,TASK_TRANSITIONS[state].length);
    for(const to of TASK_TRANSITIONS[state]){
      assert.ok((TASK_LIFECYCLE_STATES as readonly string[]).includes(to));
      assert.notEqual(to,state);
    }
  }
  for(const terminal of ['approved','failed','cancelled','expired'] as const)assert.deepEqual(TASK_TRANSITIONS[terminal],[]);
});

test('aprovar exige revisao, e rejeicao so retorna a fila em nova execucao',()=>{
  assert.equal(canTransitionTask('awaiting_approval','approved'),true);
  assert.equal(canTransitionTask('created','approved'),false);
  assert.equal(canTransitionTask('approved','planning'),false);
  assert.equal(canTransitionTask('changes_requested','queued'),true);
  assert.equal(canTransitionTask('changes_requested','approved'),false);
});

test('tarefas possuem tenant/office e versao positiva, sem campos inesperados',()=>{
  const task={id:ids.task,projectId:ids.project,officeId:ids.office,requestedBy:ids.owner,
    title:'Feature',description:'Teste',status:'created',version:1,currentRunId:null,
    createdAt:at,updatedAt:at};
  assert.equal(TaskSchema.parse(task).version,1);
  assert.equal(TaskSchema.safeParse({...task,version:0}).success,false);
  assert.equal(TaskSchema.safeParse({...task,projectId:'outro-tenant'}).success,false);
  assert.equal(TaskSchema.safeParse({...task,privateKey:'secret'}).success,false);
});

test('runs tem estados e marcadores temporais coerentes',()=>{
  assert.ok(TASK_RUN_STATES.includes('timed_out'));
  const run={id:ids.run,taskId:ids.task,projectId:ids.project,agentId:ids.agent,status:'queued',
    attempt:1,maxSteps:10,maxCostCents:100,startedAt:null,endedAt:null};
  assert.equal(TaskRunSchema.parse(run).status,'queued');
  assert.equal(TaskRunSchema.safeParse({...run,status:'running'}).success,false);
  assert.equal(TaskRunSchema.safeParse({...run,status:'running',startedAt:at}).success,true);
  assert.equal(TaskRunSchema.safeParse({...run,status:'succeeded',startedAt:at,endedAt:at}).success,true);
  assert.equal(TaskRunSchema.safeParse({...run,status:'succeeded',startedAt:at}).success,false);
});

test('decisoes de aprovacao necessitam hash e identidade humana',()=>{
  const approval={id:ids.approval,projectId:ids.project,taskId:ids.task,runId:ids.run,
    diffSha256:hash,status:'pending',requestedAt:at,decidedAt:null,decidedBy:null};
  assert.equal(ApprovalSchema.parse(approval).status,'pending');
  assert.equal(ApprovalSchema.safeParse({...approval,status:'approved'}).success,false);
  assert.equal(ApprovalSchema.safeParse({...approval,status:'approved',decidedAt:at,decidedBy:ids.owner}).success,true);
  assert.equal(ApprovalSchema.safeParse({...approval,diffSha256:'broken'}).success,false);
});

test('artefatos exigem sha256 e tamanho de bytes valido',()=>{
  const data={id:ids.event,projectId:ids.project,taskId:ids.task,runId:ids.run,
    relativePath:'outputs/report.json',contentType:'application/json',sha256:hash,sizeBytes:9};
  assert.equal(ArtifactSchema.parse(data).sizeBytes,9);
  assert.equal(ArtifactSchema.safeParse({...data,sizeBytes:-1}).success,false);
});

test('eventos v1 possuem envelope versionado e payload tipado',()=>{
  assert.equal(DOMAIN_EVENT_SCHEMA_VERSION,1);
  const event=fixture({runId:null,type:'task.created',payload:{title:'Nova tarefa',requestedBy:ids.owner}});
  assert.deepEqual(decodeDomainEventV1(event),event);
});

test('versao de evento desconhecida, tipo e campos inesperados sao rejeitados',()=>{
  const event=fixture({runId:null,type:'task.created',payload:{title:'Nova tarefa',requestedBy:ids.owner}});
  for(const invalid of [
    {...event,schemaVersion:2},
    {...event,type:'agent.moved_to_desk'},
    {...event,sequence:-1},
    {...event,unexpected:'secret'},
    {...event,payload:{...event.payload,unexpected:'secret'}},
  ])assert.throws(()=>decodeDomainEventV1(invalid));
});

test('eventos de transicao seguem o grafo e nao aprovam prematuramente',()=>{
  const base=fixture({type:'task.status_changed',
    payload:{from:'implementing',to:'testing',reason:null,newRunId:null}});
  assert.equal(decodeDomainEventV1(base).type,'task.status_changed');
  assert.throws(()=>decodeDomainEventV1({...base,payload:{from:'created',to:'approved',reason:null,newRunId:null}}));
});

test('aprovacao da tarefa exige ator humano mesmo quando evento de estado e valido',()=>{
  const base=fixture({type:'task.status_changed',
    payload:{from:'awaiting_approval',to:'approved',reason:null,newRunId:null}});
  assert.throws(()=>decodeDomainEventV1(base));
  assert.throws(()=>decodeDomainEventV1({...base,actor:{kind:'human',id:ids.owner},runId:null}));
  assert.equal(decodeDomainEventV1({...base,actor:{kind:'human',id:ids.owner}}).type,'task.status_changed');
});

test('revisao rejeitada exige identificador de nova execucao no evento',()=>{
  const base=fixture({type:'task.status_changed',
    payload:{from:'changes_requested',to:'queued',reason:'Nova tentativa',newRunId:ids.run}});
  assert.equal(decodeDomainEventV1(base).type,'task.status_changed');
  assert.throws(()=>decodeDomainEventV1({...base,runId:null}));
  assert.throws(()=>decodeDomainEventV1({...base,payload:{...base.payload,newRunId:null}}));
  assert.throws(()=>decodeDomainEventV1({...base,payload:{...base.payload,newRunId:ids.agent}}));
});

test('aprovacao assinada por agente ou identificador diferente e bloqueada',()=>{
  const base=fixture({type:'approval.decided',actor:{kind:'human',id:ids.owner},
    payload:{approvalId:ids.approval,decision:'approved',diffSha256:hash,decidedBy:ids.owner}});
  assert.equal(decodeDomainEventV1(base).type,'approval.decided');
  assert.throws(()=>decodeDomainEventV1({...base,actor:{kind:'agent',id:ids.agent}}));
  assert.throws(()=>decodeDomainEventV1({...base,payload:{...base.payload,decidedBy:ids.agent}}));
  assert.throws(()=>decodeDomainEventV1({...base,runId:null}));
});

test('eventos de run e artefatos nao permitem run ausente',()=>{
  const started=fixture({type:'task_run.started',actor:{kind:'agent',id:ids.agent},
    payload:{agentId:ids.agent,attempt:1}});
  assert.equal(decodeDomainEventV1(started).type,'task_run.started');
  assert.throws(()=>decodeDomainEventV1({...started,runId:null}));
  const finished=fixture({type:'task_run.finished',payload:{result:'failed',reason:'Erro'}});
  assert.equal(decodeDomainEventV1(finished).type,'task_run.finished');
  const recorded=fixture({type:'artifact.recorded',
    payload:{artifactId:ids.event,relativePath:'diff.patch',sha256:hash}});
  assert.equal(decodeDomainEventV1(recorded).type,'artifact.recorded');
  assert.throws(()=>decodeDomainEventV1({...recorded,runId:null}));
});

test('pedidos de aprovacao referenciam diff e run',()=>{
  const req=fixture({type:'approval.requested',payload:{approvalId:ids.approval,diffSha256:hash}});
  assert.equal(decodeDomainEventV1(req).type,'approval.requested');
  assert.throws(()=>decodeDomainEventV1({...req,runId:null}));
  assert.throws(()=>decodeDomainEventV1({...req,payload:{approvalId:ids.approval,diffSha256:'invalid'}}));
});
