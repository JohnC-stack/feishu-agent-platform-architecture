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

export const TaskTransitionSchema = z.object({
  taskId: z.string().uuid(),
  from: TaskStatusSchema,
  to: TaskStatusSchema,
  reason: z.string().min(1).max(2_000).optional(),
  occurredAt: z.string().datetime(),
});

export type TaskTransition = z.infer<typeof TaskTransitionSchema>;

export const executorKinds = ['direct_tool', 'api_agent', 'agent_cli'] as const;
export const ExecutorKindSchema = z.enum(executorKinds);
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;

export const executorErrorCategories = [
  'cancelled',
  'timeout',
  'validation',
  'unauthorized',
  'dependency',
  'rate_limited',
  'tool',
  'sandbox',
  'internal',
] as const;

export const ExecutorErrorCategorySchema = z.enum(executorErrorCategories);
export type ExecutorErrorCategory = z.infer<typeof ExecutorErrorCategorySchema>;

export const ExecutorFailureSchema = z.object({
  category: ExecutorErrorCategorySchema,
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

export type ExecutorFailure = z.infer<typeof ExecutorFailureSchema>;

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

export const routeChatTypes = ['p2p', 'group'] as const;
export const RouteChatTypeSchema = z.enum(routeChatTypes);
export type RouteChatType = z.infer<typeof RouteChatTypeSchema>;

export const RouteRuleConditionSchema = z
  .object({
    chatTypes: z.array(RouteChatTypeSchema).min(1).optional(),
    commands: z.array(z.string().min(1)).min(1).optional(),
    textIncludes: z.array(z.string().min(1)).min(1).optional(),
    riskLevels: z.array(RiskLevelSchema).min(1).optional(),
    hasAttachments: z.boolean().optional(),
  })
  .strict();

export type RouteRuleCondition = z.infer<typeof RouteRuleConditionSchema>;

export const RouteRuleSchema = z.object({
  id: z.string().min(1).max(100),
  version: z.number().int().positive(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  condition: RouteRuleConditionSchema,
  executor: ExecutorKindSchema,
  description: z.string().max(500).optional(),
});

export type RouteRule = z.infer<typeof RouteRuleSchema>;

export const RouteContextSchema = z.object({
  chatType: RouteChatTypeSchema,
  command: z.string().min(1).optional(),
  text: z.string().max(100_000),
  riskLevel: RiskLevelSchema,
  attachmentCount: z.number().int().nonnegative(),
});

export type RouteContext = z.infer<typeof RouteContextSchema>;

export const RouteDecisionSchema = z.object({
  executor: ExecutorKindSchema,
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().positive(),
  reason: z.string().min(1).max(500),
});

export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const conversationRoles = ['user', 'assistant', 'system', 'tool'] as const;
export const ConversationRoleSchema = z.enum(conversationRoles);
export type ConversationRole = z.infer<typeof ConversationRoleSchema>;

export const ConversationMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: ConversationRoleSchema,
  content: z.string().max(100_000),
  sourceMessageId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

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
export type ExecutorEventKind = z.infer<typeof ExecutorEventKindSchema>;

export const ExecutorEventSchema = z.object({
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  executor: ExecutorKindSchema,
  correlationId: z.string().min(1),
  attempt: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  kind: ExecutorEventKindSchema,
  createdAt: z.string().datetime(),
  message: z.string().max(20_000).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ExecutorEvent = z.infer<typeof ExecutorEventSchema>;

export const ExecutorExecutionRequestSchema = z.object({
  task: TaskRequestSchema,
  executor: ExecutorKindSchema,
  runId: z.string().uuid(),
  attempt: z.number().int().positive(),
  approvedToolNames: z.array(z.string().min(1).max(200)).max(100).default([]),
  workspacePath: z.string().min(1).max(1_000).optional(),
  previousSessionId: z.string().min(1).max(200).optional(),
});

export type ExecutorExecutionRequest = z.infer<typeof ExecutorExecutionRequestSchema>;

export const ExecutorExecutionResultSchema = z.object({
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  executor: ExecutorKindSchema,
  status: z.enum(['succeeded', 'failed', 'cancelled', 'expired']),
  events: z.array(ExecutorEventSchema),
  output: z.string().max(100_000).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  failure: ExecutorFailureSchema.optional(),
});

export type ExecutorExecutionResult = z.infer<typeof ExecutorExecutionResultSchema>;

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
