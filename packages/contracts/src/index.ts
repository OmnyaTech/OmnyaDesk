// Legacy mock contracts remain unchanged for /api/events, CLI and the pixel demo.
// Production event envelopes and typed aggregates are published as distinct V1 contracts.
export * from './domain.ts';
export * from './events.ts';

export const TASK_STATUSES = [
  'created', 'planning', 'implementing', 'testing', 'reviewing',
  'awaiting_approval', 'approved', 'changes_requested', 'failed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentRole = 'architect' | 'developer' | 'qa' | 'reviewer' | 'system' | 'user';
export type Decision = 'approve' | 'reject';

export interface OfficeTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  currentAgent: AgentRole;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeEvent {
  id: number;
  at: string;
  type: string;
  taskId: string;
  status: TaskStatus;
  actor: AgentRole;
  message: string;
}

// S16: provider-neutral contract with validated events, budgets and cancellation.
export * from './provider.ts';
