import {
  RouteContextSchema,
  RouteRuleSchema,
  TaskTransitionSchema,
  type ExecutorKind,
  type RiskLevel,
  type RouteContext,
  type RouteDecision,
  type RouteRule,
  type TaskStatus,
  type TaskTransition,
} from '@feishu-agent/contracts';

export const terminalTaskStatuses: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

const transitions: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  queued: new Set(['running', 'cancelled', 'expired']),
  running: new Set(['waiting_approval', 'succeeded', 'failed', 'cancelled', 'expired']),
  waiting_approval: new Set(['running', 'failed', 'cancelled', 'expired']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].has(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function allowedTransitions(status: TaskStatus): TaskStatus[] {
  return [...transitions[status]];
}

export function createTaskTransition(input: {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason?: string;
  occurredAt?: string;
}): TaskTransition {
  assertTransition(input.from, input.to);
  return TaskTransitionSchema.parse({
    taskId: input.taskId,
    from: input.from,
    to: input.to,
    ...(input.reason ? { reason: input.reason } : {}),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

export class RuleRouter {
  private readonly rules: RouteRule[];

  public constructor(
    rules: RouteRule[],
    private readonly fallbackExecutor: ExecutorKind = 'api_agent',
  ) {
    this.rules = rules
      .map((rule) => RouteRuleSchema.parse(rule))
      .filter((rule) => rule.enabled)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  public route(contextInput: RouteContext): RouteDecision {
    const context = RouteContextSchema.parse(contextInput);
    const match = this.rules.find((rule) => matchesRule(rule, context));
    if (!match) {
      return {
        executor: this.fallbackExecutor,
        ruleId: 'fallback',
        ruleVersion: 1,
        reason: `No enabled rule matched; selected ${this.fallbackExecutor}.`,
      };
    }
    return {
      executor: match.executor,
      ruleId: match.id,
      ruleVersion: match.version,
      reason: match.description ?? `Matched routing rule ${match.id}.`,
    };
  }
}

function matchesRule(rule: RouteRule, context: RouteContext): boolean {
  const { condition } = rule;
  return (
    (!condition.chatTypes || condition.chatTypes.includes(context.chatType)) &&
    (!condition.commands ||
      (context.command !== undefined &&
        condition.commands.some(
          (command) => command.toLowerCase() === context.command?.toLowerCase(),
        ))) &&
    (!condition.textIncludes ||
      condition.textIncludes.every((part) =>
        context.text.toLowerCase().includes(part.toLowerCase()),
      )) &&
    (!condition.riskLevels || condition.riskLevels.includes(context.riskLevel)) &&
    (condition.hasAttachments === undefined ||
      condition.hasAttachments === context.attachmentCount > 0)
  );
}

export interface OperationPolicyInput {
  operation: 'read' | 'write';
  riskLevel: RiskLevel;
}

export function requiresApproval({ operation, riskLevel }: OperationPolicyInput): boolean {
  if (operation === 'read') {
    return false;
  }

  return riskLevel === 'high' || riskLevel === 'critical';
}
