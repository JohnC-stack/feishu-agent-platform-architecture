import { z } from 'zod';

export const taskStatuses = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;

export const TaskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const executorKinds = ['direct_tool', 'api_agent', 'agent_cli'] as const;
export const ExecutorKindSchema = z.enum(executorKinds);
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const RiskLevelSchema = z.enum(riskLevels);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const AttachmentSchema = z.object({
  fileKey: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const TaskSourceSchema = z.object({
  channel: z.literal('feishu'),
  eventId: z.string().min(1),
  chatId: z.string().min(1),
  userId: z.string().min(1),
  replyTargetId: z.string().min(1),
});

export const TaskRequestSchema = z.object({
  id: z.string().uuid(),
  source: TaskSourceSchema,
  input: z.object({
    text: z.string().max(100_000),
    command: z.string().min(1).optional(),
    attachments: z.array(AttachmentSchema).default([]),
  }),
  requestedExecutor: ExecutorKindSchema.optional(),
  riskLevel: RiskLevelSchema.default('low'),
  correlationId: z.string().min(1),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type TaskRequest = z.infer<typeof TaskRequestSchema>;

export const executorEventKinds = [
  'started',
  'progress',
  'tool_call',
  'tool_result',
  'approval_required',
  'completed',
  'failed',
  'cancelled',
] as const;

export const ExecutorEventKindSchema = z.enum(executorEventKinds);

export const ExecutorEventSchema = z.object({
  taskId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  kind: ExecutorEventKindSchema,
  createdAt: z.string().datetime(),
  message: z.string().max(20_000).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ExecutorEvent = z.infer<typeof ExecutorEventSchema>;

export const HealthResponseSchema = z.object({
  service: z.string().min(1),
  status: z.enum(['ok', 'degraded']),
  version: z.string().min(1),
  checkedAt: z.string().datetime(),
  checks: z
    .array(
      z.object({
        name: z.string().min(1),
        ok: z.boolean(),
        detail: z.string().optional(),
      }),
    )
    .default([]),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
