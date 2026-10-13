import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ offset: true });
const NamedSchema = z.string().trim().min(1).max(140);
const DescriptionSchema = z.string().max(4000);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const OFFICE_TEMPLATES = ['startup', 'accounting', 'custom'] as const;
export const TASK_LIFECYCLE_STATES = [
  'created', 'queued', 'planning', 'implementing', 'testing', 'reviewing',
  'awaiting_approval', 'approved', 'changes_requested', 'retrying',
  'blocked', 'failed', 'cancelled', 'expired',
] as const;
export const TASK_RUN_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'expired', 'revoked'] as const;
export const TaskLifecycleStateSchema = z.enum(TASK_LIFECYCLE_STATES);
export const TaskRunStateSchema = z.enum(TASK_RUN_STATES);
export const ApprovalStateSchema = z.enum(APPROVAL_STATES);

export type TaskLifecycleState = z.infer<typeof TaskLifecycleStateSchema>;
export type TaskRunState = z.infer<typeof TaskRunStateSchema>;
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ProjectSchema = z.strictObject({
  id: UuidSchema, ownerId: UuidSchema, name: NamedSchema,
  repositoryRoot: z.string().min(1).max(4096).nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
});

export const OfficeSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, name: NamedSchema,
  template: z.enum(OFFICE_TEMPLATES), createdAt: TimestampSchema,
});

export const DepartmentSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, officeId: UuidSchema,
  code: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  name: NamedSchema, enabled: z.boolean(),
});

export const SkillSchema = z.strictObject({
  id: UuidSchema, code: z.string().regex(/^[a-z][a-z0-9._-]{1,99}$/),
  version: z.number().int().positive(), description: DescriptionSchema,
  enabled: z.boolean(),
});

export const ProviderPolicySchema = z.strictObject({
  mode: z.enum(['automatic', 'fixed']),
  preferredProvider: z.string().trim().min(1).max(100).nullable(),
  allowedProviders: z.array(z.string().trim().min(1).max(100)).min(1),
}).superRefine((value, context) => {
  if (new Set(value.allowedProviders).size !== value.allowedProviders.length) {
    context.addIssue({ code: 'custom', message: 'allowedProviders must be unique' });
  }
  if (value.mode === 'fixed' && (!value.preferredProvider || !value.allowedProviders.includes(value.preferredProvider))) {
    context.addIssue({ code: 'custom', message: 'fixed provider must be in allowedProviders' });
  }
});

export const AgentSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, officeId: UuidSchema,
  departmentId: UuidSchema, displayName: NamedSchema,
  role: z.string().trim().min(1).max(100),
  skillIds: z.array(UuidSchema),
  providerPolicy: ProviderPolicySchema, enabled: z.boolean(),
});

export const TaskSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, officeId: UuidSchema,
  requestedBy: UuidSchema, title: NamedSchema, description: DescriptionSchema,
  status: TaskLifecycleStateSchema, version: z.number().int().positive(),
  currentRunId: UuidSchema.nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
});

export const TaskRunSchema = z.strictObject({
  id: UuidSchema, taskId: UuidSchema, projectId: UuidSchema,
  agentId: UuidSchema, status: TaskRunStateSchema,
  attempt: z.number().int().positive(), maxSteps: z.number().int().positive(),
  maxCostCents: z.number().int().nonnegative(),
  startedAt: TimestampSchema.nullable(), endedAt: TimestampSchema.nullable(),
}).superRefine((value, context) => {
  if (value.status === 'queued' && (value.startedAt !== null || value.endedAt !== null)) {
    context.addIssue({ code: 'custom', message: 'Queued runs have no timestamps' });
  }
  if (value.status === 'running' && (value.startedAt === null || value.endedAt !== null)) {
    context.addIssue({ code: 'custom', message: 'Running runs require startedAt and no endedAt' });
  }
  if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(value.status) && (value.startedAt === null || value.endedAt === null)) {
    context.addIssue({ code: 'custom', message: 'Completed runs require start and end timestamps' });
  }
});

export const ApprovalSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, taskId: UuidSchema,
  runId: UuidSchema, diffSha256: Sha256Schema,
  status: ApprovalStateSchema, requestedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(), decidedBy: UuidSchema.nullable(),
}).superRefine((value, context) => {
  if (value.status === 'pending' && (value.decidedAt !== null || value.decidedBy !== null)) {
    context.addIssue({ code: 'custom', message: 'Pending approval cannot have a decision' });
  }
  if (['approved', 'rejected'].includes(value.status) && (value.decidedBy === null || value.decidedAt === null)) {
    context.addIssue({ code: 'custom', message: 'Human decision identity and timestamp required' });
  }
  if (['expired', 'revoked'].includes(value.status) && value.decidedAt === null) {
    context.addIssue({ code: 'custom', message: 'Closure timestamp required' });
  }
});

export const ArtifactSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, taskId: UuidSchema,
  runId: UuidSchema, relativePath: z.string().min(1).max(4096),
  contentType: z.string().trim().min(1).max(150),
  sha256: Sha256Schema, sizeBytes: z.number().int().nonnegative(),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Office = z.infer<typeof OfficeSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskRun = z.infer<typeof TaskRunSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

// Pure domain rule. Persistence and authorization of requests belong to future sprints.
export const TASK_TRANSITIONS: Readonly<Record<TaskLifecycleState, readonly TaskLifecycleState[]>> = {
  created: ['queued', 'cancelled'],
  queued: ['planning', 'blocked', 'cancelled', 'expired'],
  planning: ['implementing', 'retrying', 'blocked', 'failed', 'cancelled'],
  implementing: ['testing', 'retrying', 'blocked', 'failed', 'cancelled'],
  testing: ['reviewing', 'retrying', 'failed', 'cancelled'],
  reviewing: ['awaiting_approval', 'retrying', 'blocked', 'failed', 'cancelled'],
  awaiting_approval: ['approved', 'changes_requested', 'expired', 'cancelled'],
  approved: [],
  changes_requested: ['queued', 'cancelled'],
  retrying: ['queued', 'failed', 'cancelled'],
  blocked: ['queued', 'cancelled', 'expired'],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransitionTask(from: TaskLifecycleState, to: TaskLifecycleState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
