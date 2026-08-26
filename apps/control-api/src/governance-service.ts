import { createHash, randomUUID } from 'node:crypto';

import type {
  ApprovalDecisionAction,
  BudgetLimit,
  BudgetScopeType,
  GovernedOperationRequest,
  GovernanceRole,
  GovernanceRoleBinding,
  RiskLevel,
  RouteChatType,
  TaskRequest,
} from '@feishu-agent/contracts';
import type {
  ApprovalRecord,
  GovernedOperationRecord,
  GovernanceRepository,
} from '@feishu-agent/database';
import { RbacPolicy, defaultGovernanceRoles } from '@feishu-agent/policy';

import type { GovernanceConfig } from './governance-config.js';

export const governanceToolCatalog = [
  'platform.ping',
  'platform.health',
  'gitlab.read',
  'confluence.read',
  'feishu.read',
  'agent_cli.execute',
] as const;

export interface GovernanceRepositoryPort {
  seedPolicy(
    roles: GovernanceRole[],
    bindings: GovernanceRoleBinding[],
    managedBy?: string,
  ): Promise<void>;
  getPolicySnapshot(): Promise<{ roles: GovernanceRole[]; bindings: GovernanceRoleBinding[] }>;
  upsertRoleBinding(binding: GovernanceRoleBinding, managedBy: string): Promise<void>;
  deleteRoleBinding(binding: GovernanceRoleBinding): Promise<'deleted' | 'protected' | 'not_found'>;
  upsertBudgetLimit(limit: BudgetLimit): Promise<void>;
  reserveBudget(input: {
    taskId: string;
    correlationId: string;
    actorId: string;
    scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }>;
    tokens: number;
    costMicros: number;
    occurredAt?: string;
  }): Promise<{ limitsApplied: number }>;
  appendAuditEvent(input: {
    correlationId: string;
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    outcome: string;
    details?: Record<string, unknown>;
    retentionDays?: number;
  }): Promise<void>;
  createGovernedOperation(input: GovernedOperationRequest): Promise<{
    operation: GovernedOperationRecord;
    approval?: ApprovalRecord;
    created: boolean;
  }>;
  decideApproval(input: {
    approvalId: string;
    actorId: string;
    action: ApprovalDecisionAction;
    reason?: string;
    allowSelfApproval?: boolean;
    occurredAt?: string;
  }): Promise<{ approval: ApprovalRecord; operation: GovernedOperationRecord }>;
  claimOperationExecution(
    operationId: string,
  ): Promise<{ claimed: boolean; operation: GovernedOperationRecord }>;
  completeOperation(input: {
    operationId: string;
    claimToken: string;
    outcome: 'succeeded' | 'failed';
    resultReference?: string;
    errorCode?: string;
  }): Promise<GovernedOperationRecord>;
  exportAuditEvents(input: {
    from: string;
    to: string;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
  purgeExpiredAuditEvents(now?: string): Promise<number>;
}

export interface ApprovalCardSender {
  send(input: {
    approvalId: string;
    chatId: string;
    card: Record<string, unknown>;
  }): Promise<{ messageId: string }>;
}

export class GovernanceAuthorizationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceAuthorizationError';
  }
}

export class GovernanceService {
  private policy?: RbacPolicy;

  public constructor(
    private readonly repository: GovernanceRepositoryPort,
    private readonly config: GovernanceConfig,
    private readonly approvalCards?: ApprovalCardSender,
  ) {}

  public async initialize(): Promise<void> {
    await this.repository.seedPolicy(defaultGovernanceRoles, this.config.bindings, 'bootstrap');
    const snapshot = await this.repository.getPolicySnapshot();
    this.policy = new RbacPolicy(snapshot.roles, snapshot.bindings);
  }

  public capabilities(input: { userId: string; groupIds?: string[] }): {
    tools: string[];
    canDecideApprovals: boolean;
    canExportAudit: boolean;
    canManageBudgets: boolean;
    canViewAdmin: boolean;
    canOperateAdmin: boolean;
    canManageAlerts: boolean;
    canManageAccess: boolean;
    canManageReleases: boolean;
    canManageBackups: boolean;
    canManageConfig: boolean;
  } {
    const policy = this.requirePolicy();
    return {
      tools: policy.visibleTools({
        userId: input.userId,
        groupIds: input.groupIds,
        toolNames: [...governanceToolCatalog],
      }),
      canDecideApprovals: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'approval.decide',
      }).allowed,
      canExportAudit: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'audit.export',
      }).allowed,
      canManageBudgets: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'budget.manage',
      }).allowed,
      canViewAdmin: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'admin.read',
      }).allowed,
      canOperateAdmin: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'admin.operate',
      }).allowed,
      canManageAlerts: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'alert.manage',
      }).allowed,
      canManageAccess: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'access.manage',
      }).allowed,
      canManageReleases: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'release.manage',
      }).allowed,
      canManageBackups: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'backup.manage',
      }).allowed,
      canManageConfig: policy.authorizeAction({
        userId: input.userId,
        groupIds: input.groupIds,
        action: 'config.manage',
      }).allowed,
    };
  }

  public authorizeAdminRead(input: { userId: string; groupIds?: string[] }): string[] {
    return this.authorizeGovernanceAction(input, 'admin.read', 'ADMIN_READ_NOT_AUTHORIZED');
  }

  public authorizeAdminOperation(input: { userId: string; groupIds?: string[] }): string[] {
    return this.authorizeGovernanceAction(input, 'admin.operate', 'ADMIN_WRITE_NOT_AUTHORIZED');
  }

  public authorizeAlertManagement(input: { userId: string; groupIds?: string[] }): string[] {
    return this.authorizeGovernanceAction(input, 'alert.manage', 'ALERT_MANAGE_NOT_AUTHORIZED');
  }

  public authorizeAccessManagement(input: { userId: string; groupIds?: string[] }): string[] {
    return this.authorizeGovernanceAction(input, 'access.manage', 'ACCESS_MANAGE_NOT_AUTHORIZED');
  }

  public authorizeConfigManagement(input: { userId: string; groupIds?: string[] }): string[] {
    return this.authorizeGovernanceAction(input, 'config.manage', 'CONFIG_MANAGE_NOT_AUTHORIZED');
  }

  public async upsertRoleBinding(
    identity: { userId: string; groupIds?: string[] },
    binding: GovernanceRoleBinding,
  ): Promise<{ saved: true; roleIds: string[] }> {
    const roleIds = this.authorizeAccessManagement(identity);
    await this.repository.upsertRoleBinding(binding, 'admin-console');
    await this.reloadPolicy();
    await this.recordAdminAudit({
      correlationId: randomUUID(),
      actorId: identity.userId,
      action: 'access.role_binding.upsert',
      resourceType: 'governance_role_binding',
      resourceId: `${binding.principalType}:${binding.principalId}:${binding.roleId}`,
      outcome: 'succeeded',
      details: { roleIds, principalType: binding.principalType, roleId: binding.roleId },
    });
    return { saved: true, roleIds };
  }

  public async deleteRoleBinding(
    identity: { userId: string; groupIds?: string[] },
    binding: GovernanceRoleBinding,
  ): Promise<{ result: 'deleted' | 'protected' | 'not_found'; roleIds: string[] }> {
    const roleIds = this.authorizeAccessManagement(identity);
    if (
      binding.principalType === 'user' &&
      binding.principalId === identity.userId &&
      binding.roleId === 'administrator'
    ) {
      throw new GovernanceAuthorizationError(
        'SUPER_ADMIN_SELF_REMOVAL_BLOCKED',
        '超级管理员不能在当前会话中移除自己的最高权限。',
      );
    }
    const result = await this.repository.deleteRoleBinding(binding);
    if (result === 'deleted') await this.reloadPolicy();
    await this.recordAdminAudit({
      correlationId: randomUUID(),
      actorId: identity.userId,
      action: 'access.role_binding.delete',
      resourceType: 'governance_role_binding',
      resourceId: `${binding.principalType}:${binding.principalId}:${binding.roleId}`,
      outcome: result,
      details: { roleIds, principalType: binding.principalType, roleId: binding.roleId },
    });
    return { result, roleIds };
  }

  public recordAdminAudit(input: {
    correlationId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    outcome: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    return this.repository.appendAuditEvent({
      correlationId: input.correlationId,
      actorType: 'platform_user',
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      outcome: input.outcome,
      ...(input.details ? { details: input.details } : {}),
      retentionDays: this.config.auditRetentionDays,
    });
  }

  public async authorizeTask(request: TaskRequest, chatType: RouteChatType): Promise<void> {
    const target = taskAuthorizationTarget(request);
    const groups = chatType === 'group' ? [request.source.chatId] : [];
    const decision = this.requirePolicy().authorizeTool({
      userId: request.source.userId,
      groupIds: groups,
      toolName: target.toolName,
      ...(target.resourceType ? { resourceType: target.resourceType } : {}),
      ...(target.resourceId ? { resourceId: target.resourceId } : {}),
    });
    if (!decision.allowed) {
      await this.repository.appendAuditEvent({
        correlationId: request.correlationId,
        actorType: 'feishu_user',
        actorId: request.source.userId,
        action: 'tool.invoke',
        resourceType: target.resourceType ?? 'tool',
        resourceId: target.resourceId ?? target.toolName,
        outcome: 'denied',
        details: { toolName: target.toolName, roleIds: decision.roleIds },
        retentionDays: this.config.auditRetentionDays,
      });
      throw new GovernanceAuthorizationError(
        'TOOL_NOT_AUTHORIZED',
        'The requesting principal cannot view or invoke this tool.',
      );
    }
    await this.reserveTaskBudget(request, chatType);
    await this.repository.appendAuditEvent({
      correlationId: request.correlationId,
      actorType: 'feishu_user',
      actorId: request.source.userId,
      action: 'tool.invoke',
      resourceType: target.resourceType ?? 'tool',
      resourceId: target.resourceId ?? target.toolName,
      outcome: 'authorized',
      details: { toolName: target.toolName, roleIds: decision.roleIds },
      retentionDays: this.config.auditRetentionDays,
    });
  }

  public async requestOperation(input: {
    taskId: string;
    requestedBy: string;
    chatId: string;
    groupIds?: string[];
    toolName: string;
    riskLevel: RiskLevel;
    resourceType: string;
    resourceId: string;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    now?: Date;
  }) {
    const decision = this.requirePolicy().authorizeTool({
      userId: input.requestedBy,
      groupIds: input.groupIds,
      toolName: input.toolName,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
    if (!decision.allowed) {
      throw new GovernanceAuthorizationError(
        'WRITE_TOOL_NOT_AUTHORIZED',
        'The requesting principal is not authorized for this write tool and resource.',
      );
    }
    const now = input.now ?? new Date();
    const payload = input.payload ?? {};
    const request: GovernedOperationRequest = {
      id: randomUUID(),
      taskId: input.taskId,
      requestedBy: input.requestedBy,
      chatId: input.chatId,
      toolName: input.toolName,
      operation: 'write',
      riskLevel: input.riskLevel,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hashOperation({
        taskId: input.taskId,
        requestedBy: input.requestedBy,
        chatId: input.chatId,
        toolName: input.toolName,
        riskLevel: input.riskLevel,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        payload,
      }),
      payload,
      expiresAt: new Date(now.getTime() + this.config.approvalTtlSeconds * 1_000).toISOString(),
    };
    const result = await this.repository.createGovernedOperation(request);
    const card = result.approval ? buildApprovalCard(result.approval, result.operation) : undefined;
    let delivery: { messageId: string } | undefined;
    if (result.created && result.approval && card && this.approvalCards) {
      try {
        delivery = await this.approvalCards.send({
          approvalId: result.approval.id,
          chatId: input.chatId,
          card,
        });
        await this.repository.appendAuditEvent({
          correlationId: input.taskId,
          actorType: 'system',
          actorId: 'control-api',
          action: 'approval.card.deliver',
          resourceType: 'approval',
          resourceId: result.approval.id,
          outcome: 'succeeded',
          details: { messageId: delivery.messageId },
          retentionDays: this.config.auditRetentionDays,
        });
      } catch (error: unknown) {
        await this.repository.appendAuditEvent({
          correlationId: input.taskId,
          actorType: 'system',
          actorId: 'control-api',
          action: 'approval.card.deliver',
          resourceType: 'approval',
          resourceId: result.approval.id,
          outcome: 'failed',
          details: { error: error instanceof Error ? error.name : 'UnknownError' },
          retentionDays: this.config.auditRetentionDays,
        });
        throw error;
      }
    }
    return {
      ...result,
      ...(card ? { card } : {}),
      ...(delivery ? { delivery } : {}),
    };
  }

  public decideApproval(input: {
    approvalId: string;
    actorId: string;
    groupIds?: string[];
    action: ApprovalDecisionAction;
    reason?: string;
  }) {
    const permission = input.action === 'revoke' ? 'approval.revoke' : 'approval.decide';
    const decision = this.requirePolicy().authorizeAction({
      userId: input.actorId,
      groupIds: input.groupIds,
      action: permission,
    });
    if (!decision.allowed) {
      throw new GovernanceAuthorizationError(
        'APPROVAL_NOT_AUTHORIZED',
        'The requesting principal cannot decide this approval.',
      );
    }
    return this.repository.decideApproval({
      approvalId: input.approvalId,
      actorId: input.actorId,
      action: input.action,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  public async executeOnce<T>(
    operationId: string,
    executor: (operation: GovernedOperationRecord) => Promise<{
      value: T;
      resultReference?: string;
    }>,
  ): Promise<{ executed: boolean; operation: GovernedOperationRecord; value?: T }> {
    const claim = await this.repository.claimOperationExecution(operationId);
    if (!claim.claimed || !claim.operation.executionClaimToken) {
      return { executed: false, operation: claim.operation };
    }
    try {
      const result = await executor(claim.operation);
      const operation = await this.repository.completeOperation({
        operationId,
        claimToken: claim.operation.executionClaimToken,
        outcome: 'succeeded',
        ...(result.resultReference ? { resultReference: result.resultReference } : {}),
      });
      return { executed: true, operation, value: result.value };
    } catch (error: unknown) {
      await this.repository.completeOperation({
        operationId,
        claimToken: claim.operation.executionClaimToken,
        outcome: 'failed',
        errorCode: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  public async exportAudit(input: {
    actorId: string;
    groupIds?: string[];
    from: string;
    to: string;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const decision = this.requirePolicy().authorizeAction({
      userId: input.actorId,
      groupIds: input.groupIds,
      action: 'audit.export',
    });
    if (!decision.allowed) {
      throw new GovernanceAuthorizationError(
        'AUDIT_EXPORT_NOT_AUTHORIZED',
        'The requesting principal cannot export audit records.',
      );
    }
    return this.repository.exportAuditEvents({
      from: input.from,
      to: input.to,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  public purgeAudit(now?: string): Promise<number> {
    return this.repository.purgeExpiredAuditEvents(now);
  }

  private async reserveTaskBudget(request: TaskRequest, chatType: RouteChatType): Promise<void> {
    const tokens = readMetadataInteger(request.metadata, 'estimatedTokens');
    const costMicros = readMetadataInteger(request.metadata, 'estimatedCostMicros');
    const model = readMetadataString(request.metadata, 'model');
    const scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }> = [
      { scopeType: 'user', scopeId: request.source.userId },
      { scopeType: 'task', scopeId: request.id },
    ];
    const limits: BudgetLimit[] = [
      {
        scopeType: 'user',
        scopeId: request.source.userId,
        period: 'day',
        ...this.config.budgetDefaults.userDaily,
      },
      {
        scopeType: 'task',
        scopeId: request.id,
        period: 'task',
        ...this.config.budgetDefaults.task,
      },
    ];
    if (chatType === 'group') {
      scopes.push({ scopeType: 'group', scopeId: request.source.chatId });
      limits.push({
        scopeType: 'group',
        scopeId: request.source.chatId,
        period: 'day',
        ...this.config.budgetDefaults.groupDaily,
      });
    }
    if (model) {
      scopes.push({ scopeType: 'model', scopeId: model });
      limits.push({
        scopeType: 'model',
        scopeId: model,
        period: 'day',
        ...this.config.budgetDefaults.modelDaily,
      });
    }
    for (const limit of limits) {
      await this.repository.upsertBudgetLimit(limit);
    }
    await this.repository.reserveBudget({
      taskId: request.id,
      correlationId: request.correlationId,
      actorId: request.source.userId,
      scopes,
      tokens,
      costMicros,
      occurredAt: request.createdAt,
    });
  }

  private requirePolicy(): RbacPolicy {
    if (!this.policy) {
      throw new Error('Governance service must be initialized before use.');
    }
    return this.policy;
  }

  private async reloadPolicy(): Promise<void> {
    const snapshot = await this.repository.getPolicySnapshot();
    this.policy = new RbacPolicy(snapshot.roles, snapshot.bindings);
  }

  private authorizeGovernanceAction(
    input: { userId: string; groupIds?: string[] },
    action: 'admin.read' | 'admin.operate' | 'alert.manage' | 'access.manage' | 'config.manage',
    code: string,
  ): string[] {
    const decision = this.requirePolicy().authorizeAction({
      userId: input.userId,
      groupIds: input.groupIds,
      action,
    });
    if (!decision.allowed) {
      throw new GovernanceAuthorizationError(
        code,
        'The requesting principal is not authorized for this administrative capability.',
      );
    }
    return decision.roleIds;
  }
}

export function createGovernanceService(
  repository: GovernanceRepository,
  config: GovernanceConfig,
  approvalCards?: ApprovalCardSender,
): GovernanceService {
  return new GovernanceService(repository, config, approvalCards);
}

export function buildApprovalCard(
  approval: ApprovalRecord,
  operation: GovernedOperationRecord,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: operation.riskLevel === 'critical' ? 'red' : 'orange',
      title: { tag: 'plain_text', content: '高风险操作审批' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**工具：** ${operation.toolName}`,
          `**资源：** ${operation.resourceType}/${operation.resourceId}`,
          `**风险：** ${operation.riskLevel}`,
          `**申请人：** ${operation.requestedBy}`,
          `**过期时间：** ${formatFeishuDateTime(approval.expiresAt)}`,
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '批准' },
            type: 'primary',
            value: { approvalId: approval.id, action: 'approve' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { approvalId: approval.id, action: 'reject' },
          },
        ],
      },
    ],
  };
}

function formatFeishuDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const [year, month, day, hour, minute, second] = [
    read('year'),
    read('month'),
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  ];
  return year && month && day && hour && minute && second
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}`
    : value;
}

function taskAuthorizationTarget(request: TaskRequest): {
  toolName: (typeof governanceToolCatalog)[number];
  resourceType?: string;
  resourceId?: string;
} {
  const command = (
    request.input.command ??
    request.input.text.trim().split(/\s+/, 1)[0] ??
    ''
  ).toLowerCase();
  if (command === '/ping') return { toolName: 'platform.ping' };
  if (command === '/health') return { toolName: 'platform.health' };
  if (command === '/gitlab') {
    return { toolName: 'gitlab.read', resourceType: 'gitlab', resourceId: '*' };
  }
  if (command === '/confluence') {
    return { toolName: 'confluence.read', resourceType: 'confluence', resourceId: '*' };
  }
  if (command === '/feishu') {
    return { toolName: 'feishu.read', resourceType: 'feishu', resourceId: '*' };
  }
  return {
    toolName: 'agent_cli.execute',
    resourceType: 'workspace',
    resourceId: readMetadataString(request.metadata, 'workspacePath') ?? '*',
  };
}

function hashOperation(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readMetadataInteger(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${key} metadata must be a non-negative safe integer.`);
  }
  return value as number;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
