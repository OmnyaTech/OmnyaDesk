import { z } from 'zod';
import { UuidSchema, TimestampSchema, TaskLifecycleStateSchema, canTransitionTask } from './domain.ts';

// Public production contract V1. The mock /api/events wire format remains legacy until migration.
export const DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;
export const DomainActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), id: UuidSchema }),
  z.strictObject({ kind: z.literal('agent'), id: UuidSchema }),
  z.strictObject({ kind: z.literal('integration'), id: UuidSchema }),
  z.strictObject({ kind: z.literal('system'), id: z.literal('system') }),
]);

const common = {
  schemaVersion: z.literal(DOMAIN_EVENT_SCHEMA_VERSION),
  eventId: UuidSchema,
  sequence: z.number().int().positive(),
  occurredAt: TimestampSchema,
  projectId: UuidSchema,
  officeId: UuidSchema,
  taskId: UuidSchema,
  runId: UuidSchema.nullable(),
  actor: DomainActorSchema,
  correlationId: UuidSchema.nullable(),
  causationId: UuidSchema.nullable(),
  source: z.enum(['api', 'cli', 'mcp', 'vscode', 'web', 'worker', 'system']),
};

const TaskCreatedEventSchema = z.strictObject({
  ...common,
  type: z.literal('task.created'),
  payload: z.strictObject({
    title: z.string().trim().min(1).max(140),
    requestedBy: UuidSchema,
  }),
});

const TaskChangedEventSchema = z.strictObject({
  ...common,
  type: z.literal('task.status_changed'),
  payload: z.strictObject({
    from: TaskLifecycleStateSchema,
    to: TaskLifecycleStateSchema,
    reason: z.string().max(2000).nullable(),
    newRunId: UuidSchema.nullable(),
  }),
});

const TaskRunStartedEventSchema = z.strictObject({
  ...common,
  type: z.literal('task_run.started'),
  payload: z.strictObject({
    agentId: UuidSchema,
    attempt: z.number().int().positive(),
  }),
});

const TaskRunFinishedEventSchema = z.strictObject({
  ...common,
  type: z.literal('task_run.finished'),
  payload: z.strictObject({
    result: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']),
    reason: z.string().max(2000).nullable(),
  }),
});

const ApprovalRequestedEventSchema = z.strictObject({
  ...common,
  type: z.literal('approval.requested'),
  payload: z.strictObject({
    approvalId: UuidSchema,
    diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

const ApprovalDecidedEventSchema = z.strictObject({
  ...common,
  type: z.literal('approval.decided'),
  payload: z.strictObject({
    approvalId: UuidSchema,
    decision: z.enum(['approved', 'rejected']),
    diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decidedBy: UuidSchema,
  }),
});

const ArtifactRecordedEventSchema = z.strictObject({
  ...common,
  type: z.literal('artifact.recorded'),
  payload: z.strictObject({
    artifactId: UuidSchema,
    relativePath: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export const VersionedDomainEventV1Schema = z.discriminatedUnion('type', [
  TaskCreatedEventSchema,
  TaskChangedEventSchema,
  TaskRunStartedEventSchema,
  TaskRunFinishedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalDecidedEventSchema,
  ArtifactRecordedEventSchema,
]).superRefine((event, ctx) => {
  if (event.type === 'task.status_changed') {
    if (!canTransitionTask(event.payload.from, event.payload.to)) {
      ctx.addIssue({ code: 'custom', message: 'Illegal task state transition' });
    }
    if (event.payload.to === 'approved' && (event.actor.kind !== 'human' || event.runId === null)) {
      ctx.addIssue({ code: 'custom', message: 'Approved task requires a human actor and an identified run' });
    }
    if (event.payload.from === 'changes_requested' && event.payload.to === 'queued') {
      if (event.runId === null || event.payload.newRunId !== event.runId) {
        ctx.addIssue({ code: 'custom', message: 'Rework must reference a new run' });
      }
    } else if (event.payload.newRunId !== null) {
      ctx.addIssue({ code: 'custom', message: 'newRunId allowed only when requeuing after changes requested' });
    }
  }
  if (event.type === 'approval.decided') {
    if (event.actor.kind !== 'human' || event.actor.id !== event.payload.decidedBy) {
      ctx.addIssue({ code: 'custom', message: 'Approval decision must be issued by the identified human' });
    }
    if (event.runId === null) {
      ctx.addIssue({ code: 'custom', message: 'Approval decision must identify an immutable run' });
    }
  }
  if (event.type === 'approval.requested' && event.runId === null) {
    ctx.addIssue({ code: 'custom', message: 'Approval request must identify a run' });
  }
  if (['task_run.started', 'task_run.finished', 'artifact.recorded'].includes(event.type) && event.runId === null) {
    ctx.addIssue({ code: 'custom', message: 'Run or artifact event must identify a run' });
  }
  if (event.type === 'task.created' && event.runId !== null) {
    ctx.addIssue({ code: 'custom', message: 'New task has no run yet' });
  }
});

export type VersionedDomainEventV1 = z.infer<typeof VersionedDomainEventV1Schema>;

export function decodeDomainEventV1(value: unknown): VersionedDomainEventV1 {
  // Rejects unknown schema versions and additional properties rather than guessing an upcast.
  return VersionedDomainEventV1Schema.parse(value);
}
