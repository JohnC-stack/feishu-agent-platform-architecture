import { describe, expect, it, vi } from 'vitest';

import type {
  ApprovalDecisionAction,
  BudgetLimit,
  BudgetScopeType,
  GovernedOperationRequest,
  GovernanceRole,
  GovernanceRoleBinding,
  TaskRequest,
} from '@feishu-agent/contracts';
import type { ApprovalRecord, GovernedOperationRecord } from '@feishu-agent/database';

import type { GovernanceConfig } from './governance-config.js';
import {
  GovernanceAuthorizationError,
  GovernanceService,
  type GovernanceRepositoryPort,
} from './governance-service.js';

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-p5-1',
    chatId: 'chat-p5',
    userId: 'reader-1',
    replyTargetId: 'message-p5-1',
  },
  input: { text: '/health', attachments: [] },
  riskLevel: 'low',
  correlationId: 'correlation-p5-1',
  createdAt: '2026-08-21T00:00:00.000Z',
  metadata: { estimatedTokens: 10, estimatedCostMicros: 5 },
};

const config: GovernanceConfig = {
  bindings: [
    { principalType: 'user', principalId: 'reader-1', roleId: 'reader' },
    { principalType: 'user', principalId: 'admin-1', roleId: 'administrator' },
    { principalType: 'user', principalId: 'admin-2', roleId: 'administrator' },
  ],
  approvalTtlSeconds: 3_600,
  auditRetentionDays: 365,
  budgetDefaults: {
    userDaily: { tokenLimit: 1_000, costLimitMicros: 1_000 },
    groupDaily: { tokenLimit: 10_000, costLimitMicros: 10_000 },
    task: { tokenLimit: 500, costLimitMicros: 500 },
    modelDaily: { tokenLimit: 100_000, costLimitMicros: 100_000 },
  },
};

class MemoryGovernanceRepository implements GovernanceRepositoryPort {
  public roles: GovernanceRole[] = [];
  public bindings: GovernanceRoleBinding[] = [];
  public limits: BudgetLimit[] = [];
  public audits: Array<Record<string, unknown>> = [];
  public reservations = 0;
  private operation?: GovernedOperationRecord;
  private approval?: ApprovalRecord;

  public seedPolicy(roles: GovernanceRole[], bindings: GovernanceRoleBinding[]): Promise<void> {
    this.roles = roles;
    this.bindings = bindings;
    return Promise.resolve();
  }

  public getPolicySnapshot(): Promise<{
    roles: GovernanceRole[];
    bindings: GovernanceRoleBinding[];
  }> {
    return Promise.resolve({ roles: this.roles, bindings: this.bindings });
  }

  public upsertBudgetLimit(limit: BudgetLimit): Promise<void> {
    this.limits.push(limit);
    return Promise.resolve();
  }

  public reserveBudget(input: {
    taskId: string;
    correlationId: string;
    actorId: string;
    scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }>;
    tokens: number;
    costMicros: number;
  }): Promise<{ limitsApplied: number }> {
    void input;
    this.reservations += 1;
    return Promise.resolve({ limitsApplied: this.limits.length });
  }

  public appendAuditEvent(input: Record<string, unknown>): Promise<void> {
    this.audits.push(input);
    return Promise.resolve();
  }

  public createGovernedOperation(input: GovernedOperationRequest): Promise<{
    operation: GovernedOperationRecord;
    approval?: ApprovalRecord;
    created: boolean;
  }> {
    this.operation = {
      id: input.id,
      taskId: input.taskId,
      requestedBy: input.requestedBy,
      chatId: input.chatId,
      toolName: input.toolName,
      operation: input.operation,
      riskLevel: input.riskLevel,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status: 'pending_approval',
      approvalRequestId: '0aeb29c6-541d-4f73-805e-9bf09e2d9f76',
      expiresAt: input.expiresAt,
    };
    this.approval = {
      id: '0aeb29c6-541d-4f73-805e-9bf09e2d9f76',
      taskId: input.taskId,
      operationId: input.id,
      requestedBy: input.requestedBy,
      status: 'pending',
      expiresAt: input.expiresAt,
      version: 1,
    };
    return Promise.resolve({ operation: this.operation, approval: this.approval, created: true });
  }

  public decideApproval(input: {
    approvalId: string;
    actorId: string;
    action: ApprovalDecisionAction;
  }): Promise<{ approval: ApprovalRecord; operation: GovernedOperationRecord }> {
    if (!this.operation || !this.approval) throw new Error('operation missing');
    this.operation = {
      ...this.operation,
      status: input.action === 'approve' ? 'approved' : 'rejected',
    };
    this.approval = {
      ...this.approval,
      status: input.action === 'approve' ? 'approved' : 'rejected',
      decidedBy: input.actorId,
      version: 2,
    };
    return Promise.resolve({ operation: this.operation, approval: this.approval });
  }

  public claimOperationExecution(): Promise<{
    claimed: boolean;
    operation: GovernedOperationRecord;
  }> {
    if (!this.operation) throw new Error('operation missing');
    if (this.operation.status !== 'approved') {
      return Promise.resolve({ claimed: false, operation: this.operation });
    }
    this.operation = {
      ...this.operation,
      status: 'executing',
      executionClaimToken: '03e86b8a-8620-4a83-af3c-a0036b8fd70c',
    };
    return Promise.resolve({ claimed: true, operation: this.operation });
  }

  public completeOperation(input: {
    outcome: 'succeeded' | 'failed';
  }): Promise<GovernedOperationRecord> {
    if (!this.operation) throw new Error('operation missing');
    this.operation = { ...this.operation, status: input.outcome };
    return Promise.resolve(this.operation);
  }

  public exportAuditEvents(): Promise<Array<Record<string, unknown>>> {
    return Promise.resolve(this.audits);
  }

  public purgeExpiredAuditEvents(): Promise<number> {
    return Promise.resolve(0);
  }
}

describe('P5 governance service', () => {
  it('hides unauthorized tools and rejects invocation before queueing', async () => {
    const repository = new MemoryGovernanceRepository();
    const governance = new GovernanceService(repository, config);
    await governance.initialize();
    expect(governance.capabilities({ userId: 'unknown' }).tools).toEqual([]);
    await expect(
      governance.authorizeTask({ ...task, source: { ...task.source, userId: 'unknown' } }, 'group'),
    ).rejects.toBeInstanceOf(GovernanceAuthorizationError);
    expect(repository.reservations).toBe(0);
    expect(repository.audits).toHaveLength(1);
  });

  it('authorizes a scoped read and reserves user, group, and task budgets', async () => {
    const repository = new MemoryGovernanceRepository();
    const governance = new GovernanceService(repository, config);
    await governance.initialize();
    await expect(governance.authorizeTask(task, 'group')).resolves.toBeUndefined();
    expect(repository.reservations).toBe(1);
    expect(repository.limits.map(({ scopeType }) => scopeType).sort()).toEqual([
      'group',
      'task',
      'user',
    ]);
  });

  it('creates an approval card and executes an approved operation only once', async () => {
    const repository = new MemoryGovernanceRepository();
    const send = vi.fn(() => Promise.resolve({ messageId: 'om_p5_approval' }));
    const governance = new GovernanceService(repository, config, { send });
    await governance.initialize();
    const requested = await governance.requestOperation({
      taskId: task.id,
      requestedBy: 'admin-1',
      chatId: task.source.chatId,
      toolName: 'agent_cli.execute',
      riskLevel: 'critical',
      resourceType: 'workspace',
      resourceId: 'D:/Codex/coding',
      idempotencyKey: 'p5-operation-idempotency-1',
      payload: { command: 'synthetic-write' },
      now: new Date('2026-08-21T00:00:00.000Z'),
    });
    expect(requested.operation.status).toBe('pending_approval');
    expect(JSON.stringify(requested.card)).toContain('高风险操作审批');
    expect(JSON.stringify(requested.card)).toContain('2026-08-21 09:00:00');
    expect(JSON.stringify(requested.card)).not.toContain('2026-08-21T01:00:00.000Z');
    expect(requested.card).toMatchObject({ config: { update_multi: true } });
    expect(requested.delivery).toEqual({ messageId: 'om_p5_approval' });
    expect(send).toHaveBeenCalledOnce();
    const blocked = await governance.executeOnce(requested.operation.id, () =>
      Promise.resolve({ value: 'should-not-run' }),
    );
    expect(blocked.executed).toBe(false);

    await governance.decideApproval({
      approvalId: requested.approval?.id ?? '',
      actorId: 'admin-2',
      action: 'approve',
    });
    let calls = 0;
    const first = await governance.executeOnce(requested.operation.id, () => {
      calls += 1;
      return Promise.resolve({ value: 'executed', resultReference: 'synthetic:1' });
    });
    const duplicate = await governance.executeOnce(requested.operation.id, () => {
      calls += 1;
      return Promise.resolve({ value: 'duplicate' });
    });
    expect(first.executed).toBe(true);
    expect(duplicate.executed).toBe(false);
    expect(calls).toBe(1);
  });
});
