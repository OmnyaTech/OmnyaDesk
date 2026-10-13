import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentRole, Decision, OfficeEvent, OfficeTask, TaskStatus } from '../../contracts/src/index.ts';

const transitions: Record<TaskStatus, TaskStatus[]> = {
  created: ['planning', 'failed'],
  planning: ['implementing', 'failed'],
  implementing: ['testing', 'failed'],
  testing: ['reviewing', 'failed'],
  reviewing: ['awaiting_approval', 'failed'],
  awaiting_approval: ['approved', 'changes_requested', 'failed'],
  approved: [],
  changes_requested: [],
  failed: [],
};

const stages: Array<{ status: TaskStatus; agent: AgentRole; message: string }> = [
  { status: 'planning', agent: 'architect', message: 'Arquiteto preparando o plano (simulado)' },
  { status: 'implementing', agent: 'developer', message: 'Desenvolvedor trabalhando (simulado; não altera arquivos)' },
  { status: 'testing', agent: 'qa', message: 'QA conferindo cenários (simulado; não executa testes reais)' },
  { status: 'reviewing', agent: 'reviewer', message: 'Revisor analisando a entrega (simulado)' },
  { status: 'awaiting_approval', agent: 'user', message: 'Tarefa pronta para decisão humana (entrega fictícia)' },
];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Apenas demonstração em memória. A versão persistente usará PostgreSQL + pg-boss. */
export class OfficeRuntime {
  private tasks = new Map<string, OfficeTask>();
  private history: OfficeEvent[] = [];
  private emitter = new EventEmitter();

  private readonly stageDelayMs: number;

  constructor(stageDelayMs = 1200) {
    this.stageDelayMs = stageDelayMs;
  }

  listTasks(): OfficeTask[] {
    return Array.from(this.tasks.values(), (task) => ({ ...task })).reverse();
  }

  listEvents(afterId = 0): OfficeEvent[] {
    return this.history.filter((event) => event.id > afterId).map((event) => ({ ...event }));
  }

  subscribe(listener: (event: OfficeEvent) => void): () => void {
    this.emitter.on('office-event', listener);
    return () => this.emitter.off('office-event', listener);
  }

  createTask(title: string, description: string): OfficeTask {
    const now = new Date().toISOString();
    const task: OfficeTask = {
      id: randomUUID(), title: title.trim(), description: description.trim(),
      status: 'created', currentAgent: 'system', createdAt: now, updatedAt: now,
    };
    if (!task.title || task.title.length > 140 || task.description.length > 4000) {
      throw new Error('Título obrigatório (até 140 caracteres); descrição até 4000.');
    }
    this.tasks.set(task.id, task);
    this.publish(task, 'task.created', 'system', 'Tarefa registrada');
    void this.runMock(task.id);
    return { ...task };
  }

  private publish(task: OfficeTask, type: string, actor: AgentRole, message: string): void {
    const event: OfficeEvent = {
      id: this.history.length + 1, at: new Date().toISOString(), type,
      taskId: task.id, status: task.status, actor, message,
    };
    this.history.push(event);
    this.emitter.emit('office-event', event);
  }

  private transition(id: string, nextStatus: TaskStatus, actor: AgentRole, message: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Tarefa inexistente.');
    if (!transitions[task.status].includes(nextStatus)) {
      throw new Error(`Transição inválida: ${task.status} → ${nextStatus}`);
    }
    task.status = nextStatus;
    task.currentAgent = actor;
    task.updatedAt = new Date().toISOString();
    this.publish(task, 'task.status_changed', actor, message);
  }

  private async runMock(id: string): Promise<void> {
    for (const stage of stages) {
      await delay(this.stageDelayMs);
      try {
        this.transition(id, stage.status, stage.agent, stage.message);
      } catch {
        return;
      }
    }
  }

  decide(id: string, decision: Decision): OfficeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Tarefa inexistente.');
    this.transition(
      id,
      decision === 'approve' ? 'approved' : 'changes_requested',
      'user',
      decision === 'approve' ? 'Aprovado manualmente (simulação)' : 'Alterações solicitadas',
    );
    return { ...task };
  }
}
