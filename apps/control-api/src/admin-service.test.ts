import { describe, expect, it, vi } from 'vitest';

import type {
  AdminDatabaseSnapshot,
  AdminOperationRecord,
  AdminTaskTrace,
  OperationalAlertInput,
  OperationalAlertRecord,
} from '@feishu-agent/database';

import {
  AdminService,
  AdminValidationError,
  confirmationText,
  type AdminRepositoryPort,
  type AdminRuntimePort,
} from './admin-service.js';
import { GovernanceAuthorizationError, type GovernanceService } from './governance-service.js';

describe('P6 admin service', () => {
  it('aggregates runtime state, creates threshold alerts, and redacts diagnostic secrets', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const runtime = createRuntimeStub({ waiting: 25, workerStatus: 'offline' });
    const service = new AdminService(repository, governance.service, runtime);

    const result = await service.snapshot({ actorId: 'admin-user' });

    expect(result.phase).toBe('P6');
    expect(result.summary.totalTasks).toBe(3);
    expect(result.summary.openAlerts).toBe(4);
    expect(result.summary.criticalAlerts).toBe(2);
    expect(result.services).toContainEqual(
      expect.objectContaining({ service: 'windows-worker', status: 'offline' }),
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-fixture');
    expect(JSON.stringify(result)).toContain('[REDACTED]');
    expect(governance.authorizeAdminRead).toHaveBeenCalledWith({
      userId: 'admin-user',
      groupIds: undefined,
    });
  });

  it('requires exact typed confirmation and audits an executable cancellation', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const cancel = vi.fn(() => Promise.resolve<'cancelling'>('cancelling'));
    const service = new AdminService(repository, governance.service, createRuntimeStub(), {
      cancel,
    });

    await expect(
      service.requestAction(
        { actorId: 'operator-user' },
        { action: 'cancel', targetType: 'task', targetId: taskId, confirmation: 'wrong' },
      ),
    ).rejects.toBeInstanceOf(AdminValidationError);

    const result = await service.requestAction(
      { actorId: 'operator-user' },
      {
        action: 'cancel',
        targetType: 'task',
        targetId: taskId,
        confirmation: confirmationText('cancel', taskId),
      },
    );

    expect(result.status).toBe('succeeded');
    expect(result.result).toEqual({ taskStatus: 'cancelling' });
    expect(cancel).toHaveBeenCalledWith(taskId);
    expect(governance.recordAdminAudit).toHaveBeenCalledTimes(2);
  });

  it('keeps high-risk retry requests pending instead of executing without approval', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const cancel = vi.fn();
    const service = new AdminService(repository, governance.service, createRuntimeStub(), {
      cancel,
    });

    const result = await service.requestAction(
      { actorId: 'operator-user' },
      {
        action: 'retry',
        targetType: 'task',
        targetId: taskId,
        confirmation: confirmationText('retry', taskId),
      },
    );

    expect(result.status).toBe('pending_approval');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('raises a dedicated critical alert when a model executor fails', async () => {
    const repository = new MemoryAdminRepository([
      { status: 'failed', executor: 'codex_cli', errorCode: 'MODEL_UNAVAILABLE' },
    ]);
    const governance = createGovernanceStub();
    const service = new AdminService(repository, governance.service, createRuntimeStub());

    const result = await service.snapshot({ actorId: 'admin-user' });

    expect(result.data.alerts).toContainEqual(
      expect.objectContaining({
        key: 'executor:model:failed',
        category: 'model',
        severity: 'critical',
      }),
    );
  });

  it('issues an opaque local session only for a loopback request when explicitly enabled', () => {
    const governance = createGovernanceStub();
    const service = new AdminService(
      new MemoryAdminRepository(),
      governance.service,
      createRuntimeStub(),
      undefined,
      undefined,
      { enabled: true, actorId: 'local-admin', ttlMs: 60_000 },
    );

    expect(service.createLocalSession('192.168.1.8')).toBeUndefined();
    const session = service.createLocalSession('127.0.0.1');

    expect(session).toMatchObject({ displayName: '本机管理员', roleIds: ['administrator'] });
    expect(JSON.stringify(session)).not.toContain('local-admin');
    expect(service.resolveLocalSession(session?.accessToken ?? '')).toEqual({
      actorId: 'local-admin',
    });
  });

  it('issues and revokes a governed Feishu session without exposing the actor id', () => {
    const governance = createGovernanceStub();
    const service = new AdminService(
      new MemoryAdminRepository(),
      governance.service,
      createRuntimeStub(),
    );

    const session = service.createFeishuSession({
      actorId: 'ou_admin',
      displayName: '飞书管理员',
      ttlMs: 60_000,
    });

    expect(session).toMatchObject({
      displayName: '飞书管理员',
      provider: 'feishu',
      roleIds: ['administrator'],
    });
    expect(JSON.stringify(session)).not.toContain('ou_admin');
    expect(service.describeSession(session.accessToken)).not.toHaveProperty('actorId');
    expect(service.revokeSession(session.accessToken)).toBe(true);
    expect(service.resolveAdminSession(session.accessToken)).toBeUndefined();
  });

  it('limits a reader session to read-only runtime pages and filters governance data', async () => {
    const governance = createGovernanceStub(['reader']);
    const service = new AdminService(
      new MemoryAdminRepository(),
      governance.service,
      createRuntimeStub(),
    );

    const session = service.createFeishuSession({
      actorId: 'ou_reader',
      displayName: '只读成员',
      ttlMs: 60_000,
    });
    const snapshot = await service.snapshot({ actorId: 'ou_reader' });

    expect(session.capabilities).toMatchObject({
      isSuperAdmin: false,
      canOperate: false,
      allowedPages: expect.arrayContaining([
        'overview',
        'tasks',
        'runtime',
        'integrations',
        'guide',
      ]),
    });
    expect(snapshot.data.tasks).toHaveLength(1);
    expect(snapshot.data.approvals).toEqual([]);
    expect(snapshot.data.budgets).toEqual([]);
    expect(snapshot.data.roleBindings).toEqual([]);
  });

  it('rejects the dedicated super administrator login for a non-administrator role', () => {
    const governance = createGovernanceStub(['operator']);
    const service = new AdminService(
      new MemoryAdminRepository(),
      governance.service,
      createRuntimeStub(),
    );

    expect(() =>
      service.createFeishuSession({
        actorId: 'ou_operator',
        displayName: '运行操作员',
        ttlMs: 60_000,
        requireSuperAdmin: true,
      }),
    ).toThrowError(GovernanceAuthorizationError);
  });
});

const taskId = '20000000-0000-4000-8000-000000000001';

class MemoryAdminRepository implements AdminRepositoryPort {
  private alerts: OperationalAlertRecord[] = [];
  private operations: AdminOperationRecord[] = [];

  public constructor(private readonly executorRuns: Array<Record<string, unknown>> = []) {}

  public getSnapshot(): Promise<AdminDatabaseSnapshot> {
    return Promise.resolve({
      taskCounts: { succeeded: 2, failed: 1 },
      tasks: [
        {
          id: taskId,
          status: 'failed',
          errorMessage: 'PRIVATE-TOKEN=synthetic-sensitive-fixture',
        },
      ],
      conversations: [],
      approvals: [{ id: 'approval', status: 'pending' }],
      executorRuns: this.executorRuns,
      roles: [],
      roleBindings: [],
      budgets: [
        {
          scopeType: 'user',
          scopeId: 'admin-user',
          period: 'day',
          tokenLimit: '100',
          tokensUsed: '100',
          costMicrosUsed: '20',
        },
      ],
      auditEvents: [],
      alerts: this.alerts,
      operations: this.operations,
      releases: [],
      backups: [],
      configVersions: [],
    });
  }

  public getTaskTrace(): Promise<AdminTaskTrace | undefined> {
    return Promise.resolve(undefined);
  }

  public reconcileAlerts(alerts: readonly OperationalAlertInput[]): Promise<void> {
    this.alerts = alerts.map((alert, index) => ({
      ...alert,
      id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      details: alert.details ?? {},
      status: 'open',
      firstSeenAt: '2026-08-21T00:00:00.000Z',
      lastSeenAt: '2026-08-21T00:00:00.000Z',
    }));
    return Promise.resolve();
  }

  public acknowledgeAlert(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public createOperation(
    input: Parameters<AdminRepositoryPort['createOperation']>[0],
  ): Promise<AdminOperationRecord> {
    const operation: AdminOperationRecord = {
      id: `40000000-0000-4000-8000-${String(this.operations.length).padStart(12, '0')}`,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      riskLevel: input.riskLevel,
      requestedBy: input.requestedBy,
      status: input.status,
      result: {},
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    };
    this.operations.unshift(operation);
    return Promise.resolve(operation);
  }

  public finishOperation(
    input: Parameters<AdminRepositoryPort['finishOperation']>[0],
  ): Promise<AdminOperationRecord> {
    const operation = this.operations.find((item) => item.id === input.operationId);
    if (!operation) throw new Error('Operation not found.');
    Object.assign(operation, {
      status: input.status,
      result: input.result ?? {},
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      finishedAt: '2026-08-21T00:00:01.000Z',
    });
    return Promise.resolve(operation);
  }
}

function createGovernanceStub(roleIds: string[] = ['administrator']) {
  const authorizeAdminRead = vi.fn(() => roleIds);
  const authorizeAdminOperation = vi.fn(() => ['operator']);
  const authorizeAlertManagement = vi.fn(() => ['operator']);
  const recordAdminAudit = vi.fn(() => Promise.resolve());
  const capabilities = vi.fn(() => ({
    tools: [],
    canDecideApprovals: roleIds.includes('administrator') || roleIds.includes('approver'),
    canExportAudit: roleIds.includes('administrator') || roleIds.includes('auditor'),
    canManageBudgets: roleIds.includes('administrator'),
    canViewAdmin: true,
    canOperateAdmin: roleIds.includes('administrator') || roleIds.includes('operator'),
    canManageAlerts: roleIds.includes('administrator') || roleIds.includes('operator'),
    canManageAccess: roleIds.includes('administrator'),
    canManageReleases: roleIds.includes('administrator'),
    canManageBackups: roleIds.includes('administrator'),
    canManageConfig: roleIds.includes('administrator'),
  }));
  const upsertRoleBinding = vi.fn(() => Promise.resolve({ saved: true as const, roleIds }));
  const deleteRoleBinding = vi.fn(() => Promise.resolve({ result: 'deleted' as const, roleIds }));
  return {
    service: {
      authorizeAdminRead,
      authorizeAdminOperation,
      authorizeAlertManagement,
      recordAdminAudit,
      capabilities,
      upsertRoleBinding,
      deleteRoleBinding,
    } as unknown as GovernanceService,
    authorizeAdminRead,
    recordAdminAudit,
  };
}

function createRuntimeStub(
  options: { waiting?: number; workerStatus?: 'ok' | 'offline' } = {},
): AdminRuntimePort {
  return {
    getQueueSnapshot: () =>
      Promise.resolve({
        waiting: options.waiting ?? 0,
        active: 0,
        delayed: 0,
        completed: 2,
        failed: 1,
        deadLettered: 0,
      }),
    getServiceHealth: () =>
      Promise.resolve([
        {
          service: 'control-api',
          status: 'ok',
          latencyMs: 0,
          checkedAt: '2026-08-21T00:00:00.000Z',
          checks: [],
        },
        {
          service: 'windows-worker',
          status: options.workerStatus ?? 'ok',
          latencyMs: 1,
          checkedAt: '2026-08-21T00:00:00.000Z',
          checks: [],
        },
      ]),
    getConfigSummary: () => [],
    getIntegrations: () => [],
  };
}
