import {
  ApprovalDecisionActionSchema,
  AuthorizationDecisionSchema,
  BudgetLimitSchema,
  BudgetUsageSchema,
  GovernanceRoleBindingSchema,
  GovernanceRoleSchema,
  RouteContextSchema,
  RouteRuleSchema,
  TaskTransitionSchema,
  ToolAuthorizationRequestSchema,
  type ApprovalDecisionAction,
  type ApprovalStatus,
  type AuthorizationDecision,
  type BudgetLimit,
  type BudgetUsage,
  type ExecutorKind,
  type GovernanceAction,
  type GovernancePermission,
  type GovernanceRole,
  type GovernanceRoleBinding,
  type RiskLevel,
  type RouteContext,
  type RouteDecision,
  type RouteRule,
  type TaskStatus,
  type TaskTransition,
  type ToolAuthorizationRequest,
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

export const defaultGovernanceRoles: GovernanceRole[] = [
  {
    id: 'reader',
    name: '只读成员',
    description: '可查看运行概况，并调用批准范围内的企业只读工具。',
    system: true,
    permissions: [
      { action: 'admin.read' },
      { action: 'tool.view', toolPattern: 'platform.*' },
      { action: 'tool.invoke', toolPattern: 'platform.*' },
      { action: 'tool.view', toolPattern: 'gitlab.read' },
      { action: 'tool.invoke', toolPattern: 'gitlab.read', resourceScope: wildcardScope() },
      { action: 'tool.view', toolPattern: 'confluence.read' },
      { action: 'tool.invoke', toolPattern: 'confluence.read', resourceScope: wildcardScope() },
      { action: 'tool.view', toolPattern: 'feishu.read' },
      { action: 'tool.invoke', toolPattern: 'feishu.read', resourceScope: wildcardScope() },
    ],
  },
  {
    id: 'operator',
    name: '运行操作员',
    description: '可查看运行数据并在治理和审批约束下发起运维操作。',
    system: true,
    permissions: [
      { action: 'tool.view', toolPattern: 'agent_cli.execute' },
      { action: 'tool.invoke', toolPattern: 'agent_cli.execute', resourceScope: wildcardScope() },
      { action: 'admin.read' },
      { action: 'admin.operate' },
      { action: 'alert.manage' },
    ],
  },
  {
    id: 'approver',
    name: '审批员',
    description: '可查看并决定受治理操作，且不能审批自己申请的操作。',
    system: true,
    permissions: [
      { action: 'admin.read' },
      { action: 'approval.decide' },
      { action: 'approval.revoke' },
    ],
  },
  {
    id: 'auditor',
    name: '审计员',
    description: '可查看和导出已经脱敏的审计与 Trace 记录。',
    system: true,
    permissions: [{ action: 'audit.read' }, { action: 'audit.export' }, { action: 'admin.read' }],
  },
  {
    id: 'administrator',
    name: '超级管理员',
    description: '拥有全部平台管理能力，但仍受审批、幂等和审计约束。',
    system: true,
    permissions: [{ action: '*', toolPattern: '*', resourceScope: wildcardScope() }],
  },
];

export type ToolAuthorizationInput = Omit<ToolAuthorizationRequest, 'groupIds'> & {
  groupIds?: string[];
};

export class RbacPolicy {
  private readonly roles: Map<string, GovernanceRole>;
  private readonly bindings: GovernanceRoleBinding[];

  public constructor(roles: GovernanceRole[], bindings: GovernanceRoleBinding[]) {
    this.roles = new Map(
      roles.map((role) => {
        const validated = GovernanceRoleSchema.parse(role);
        return [validated.id, validated];
      }),
    );
    this.bindings = bindings.map((binding) => GovernanceRoleBindingSchema.parse(binding));
    const unknownRole = this.bindings.find((binding) => !this.roles.has(binding.roleId));
    if (unknownRole) {
      throw new Error(`Role binding references unknown role: ${unknownRole.roleId}`);
    }
  }

  public authorizeTool(
    requestInput: ToolAuthorizationInput,
    action: Extract<GovernanceAction, 'tool.view' | 'tool.invoke'> = 'tool.invoke',
  ): AuthorizationDecision {
    const request = ToolAuthorizationRequestSchema.parse(requestInput);
    const roleIds = this.roleIdsFor(request.userId, request.groupIds);
    const allowed = roleIds.some((roleId) =>
      this.roles
        .get(roleId)
        ?.permissions.some((permission) => matchesToolPermission(permission, action, request)),
    );
    return AuthorizationDecisionSchema.parse({
      allowed,
      roleIds,
      reason: allowed
        ? `Authorized ${action} through role scope.`
        : `No assigned role grants ${action} for ${request.toolName}.`,
    });
  }

  public authorizeAction(input: {
    userId: string;
    groupIds?: string[];
    action: Exclude<GovernanceAction, 'tool.view' | 'tool.invoke'>;
  }): AuthorizationDecision {
    const roleIds = this.roleIdsFor(input.userId, input.groupIds ?? []);
    const allowed = roleIds.some((roleId) =>
      this.roles
        .get(roleId)
        ?.permissions.some(
          (permission) => permission.action === '*' || permission.action === input.action,
        ),
    );
    return AuthorizationDecisionSchema.parse({
      allowed,
      roleIds,
      reason: allowed
        ? `Authorized ${input.action} through role scope.`
        : `No assigned role grants ${input.action}.`,
    });
  }

  public visibleTools(input: {
    userId: string;
    groupIds?: string[];
    toolNames: string[];
  }): string[] {
    return input.toolNames.filter(
      (toolName) =>
        this.authorizeTool(
          { userId: input.userId, groupIds: input.groupIds ?? [], toolName },
          'tool.view',
        ).allowed ||
        this.authorizeTool(
          { userId: input.userId, groupIds: input.groupIds ?? [], toolName },
          'tool.invoke',
        ).allowed,
    );
  }

  private roleIdsFor(userId: string, groupIds: string[]): string[] {
    const groups = new Set(groupIds);
    return [
      ...new Set(
        this.bindings
          .filter(
            (binding) =>
              (binding.principalType === 'user' && binding.principalId === userId) ||
              (binding.principalType === 'group' && groups.has(binding.principalId)),
          )
          .map((binding) => binding.roleId),
      ),
    ].sort();
  }
}

export function nextApprovalStatus(
  current: ApprovalStatus,
  actionInput: ApprovalDecisionAction,
): ApprovalStatus {
  const action = ApprovalDecisionActionSchema.parse(actionInput);
  if (current === 'approved' && action === 'revoke') {
    return 'revoked';
  }
  if (current !== 'pending') {
    throw new Error(`Approval cannot transition from ${current} with ${action}.`);
  }
  const statuses: Record<ApprovalDecisionAction, ApprovalStatus> = {
    approve: 'approved',
    reject: 'rejected',
    revoke: 'revoked',
    expire: 'expired',
  };
  return statuses[action];
}

export function assertApprovalActor(input: {
  requestedBy: string;
  decidedBy: string;
  allowSelfApproval?: boolean;
}): void {
  if (!input.allowSelfApproval && input.requestedBy === input.decidedBy) {
    throw new Error('Requester cannot approve or reject their own governed operation.');
  }
}

export interface BudgetEvaluation {
  allowed: boolean;
  violations: Array<{
    scopeType: BudgetLimit['scopeType'];
    scopeId: string;
    dimension: 'tokens' | 'cost';
    limit: number;
    projected: number;
  }>;
}

export function evaluateBudget(input: {
  limits: BudgetLimit[];
  usage: BudgetUsage[];
  proposedTokens: number;
  proposedCostMicros: number;
}): BudgetEvaluation {
  if (!Number.isInteger(input.proposedTokens) || input.proposedTokens < 0) {
    throw new Error('proposedTokens must be a non-negative integer.');
  }
  if (!Number.isInteger(input.proposedCostMicros) || input.proposedCostMicros < 0) {
    throw new Error('proposedCostMicros must be a non-negative integer.');
  }
  const usage = input.usage.map((entry) => BudgetUsageSchema.parse(entry));
  const violations: BudgetEvaluation['violations'] = [];
  for (const limitInput of input.limits) {
    const limit = BudgetLimitSchema.parse(limitInput);
    const current = usage.find(
      (entry) =>
        entry.scopeType === limit.scopeType &&
        entry.scopeId === limit.scopeId &&
        entry.period === limit.period,
    );
    const projectedTokens = (current?.tokensUsed ?? 0) + input.proposedTokens;
    const projectedCost = (current?.costMicrosUsed ?? 0) + input.proposedCostMicros;
    if (projectedTokens > limit.tokenLimit) {
      violations.push({
        scopeType: limit.scopeType,
        scopeId: limit.scopeId,
        dimension: 'tokens',
        limit: limit.tokenLimit,
        projected: projectedTokens,
      });
    }
    if (projectedCost > limit.costLimitMicros) {
      violations.push({
        scopeType: limit.scopeType,
        scopeId: limit.scopeId,
        dimension: 'cost',
        limit: limit.costLimitMicros,
        projected: projectedCost,
      });
    }
  }
  return { allowed: violations.length === 0, violations };
}

const sensitiveAuditKey =
  /(authorization|cookie|password|secret|token|credential|private[-_]?key)/i;
const secretValue = /(bearer\s+[a-z0-9._~+/-]+=*|glpat-[a-z0-9_-]+|sk-[a-z0-9_-]+)/gi;

export function redactAuditDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditDetails(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveAuditKey.test(key) ? '[REDACTED]' : redactAuditDetails(item),
      ]),
    );
  }
  return typeof value === 'string' ? value.replace(secretValue, '[REDACTED]') : value;
}

function wildcardScope(): { resourceType: string; resourcePattern: string } {
  return { resourceType: '*', resourcePattern: '*' };
}

function matchesToolPermission(
  permission: GovernancePermission,
  action: 'tool.view' | 'tool.invoke',
  request: ToolAuthorizationRequest,
): boolean {
  if (permission.action !== '*' && permission.action !== action) {
    return false;
  }
  if (!matchesPattern(permission.toolPattern ?? '*', request.toolName)) {
    return false;
  }
  if (!permission.resourceScope) {
    return request.resourceType === undefined && request.resourceId === undefined;
  }
  return (
    matchesPattern(permission.resourceScope.resourceType, request.resourceType ?? '') &&
    matchesPattern(permission.resourceScope.resourcePattern, request.resourceId ?? '')
  );
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (!pattern.includes('*')) {
    return pattern === value;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}
