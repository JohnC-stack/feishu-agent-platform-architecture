import { describe, expect, it, vi } from 'vitest';

import type {
  AdminDatabaseSnapshot,
  AdminOperationRecord,
  AdminTaskTrace,
  OperationalAlertInput,
  OperationalAlertRecord,
  PlatformConfigVersionRecord,
} from '@feishu-agent/database';

import {
  AdminService,
  AdminValidationError,
  configPublishConfirmation,
  configRollbackConfirmation,
  confirmationText,
  createAdminRuntime,
  type AdminRepositoryPort,
  type AdminRuntimePort,
} from './admin-service.js';
import { GovernanceAuthorizationError, type GovernanceService } from './governance-service.js';

describe('P7 admin service', () => {
  it('aggregates runtime state, creates threshold alerts, and redacts diagnostic secrets', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const runtime = createRuntimeStub({ waiting: 25, workerStatus: 'offline' });
    const service = new AdminService(repository, governance.service, runtime);

    const result = await service.snapshot({ actorId: 'admin-user' });

    expect(result.phase).toBe('P7');
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

  it('validates, publishes, audits and immediately applies a managed configuration version', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const service = new AdminService(repository, governance.service, createRuntimeStub());
    const configuration = {
      'alerts.queueWaitingThreshold': 50,
      'alerts.budgetPercentThreshold': 90,
      'alerts.failedTaskThreshold': 5,
      'alerts.modelFailureThreshold': 2,
      'health.serviceProbeTimeoutMs': 3_000,
    };

    const draft = await service.createConfigDraft(
      { actorId: 'admin-user' },
      { configuration, description: '生产告警基线', changeSummary: '提高告警阈值' },
    );
    const published = await service.publishConfigDraft(
      { actorId: 'admin-user' },
      draft.id,
      configPublishConfirmation(draft.version),
    );
    const snapshot = await service.snapshot({ actorId: 'admin-user' });

    expect(published.status).toBe('active');
    expect(snapshot.managedConfiguration).toMatchObject({
      source: 'database',
      activeVersion: 1,
      effective: configuration,
    });
    expect(governance.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'config.publish', outcome: 'succeeded' }),
    );
  });

  it('rejects incorrect configuration confirmations and updates to published history', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const service = new AdminService(repository, governance.service, createRuntimeStub());
    const input = {
      configuration: { 'alerts.queueWaitingThreshold': 25 },
      description: '不可变版本验收',
      changeSummary: '确认文本与历史保护测试',
    };
    const draft = await service.createConfigDraft({ actorId: 'admin-user' }, input);

    await expect(
      service.publishConfigDraft({ actorId: 'admin-user' }, draft.id, '发布'),
    ).rejects.toBeInstanceOf(AdminValidationError);
    await service.publishConfigDraft(
      { actorId: 'admin-user' },
      draft.id,
      configPublishConfirmation(draft.version),
    );
    await expect(
      service.updateConfigDraft({ actorId: 'admin-user' }, draft.id, input),
    ).rejects.toThrow('Draft not found.');
    await expect(
      service.rollbackConfigVersion({ actorId: 'admin-user' }, draft.id, {
        confirmation: '回滚',
        changeSummary: '错误确认文本',
      }),
    ).rejects.toBeInstanceOf(AdminValidationError);
  });

  it('rejects sensitive or unknown configuration keys before persistence', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const service = new AdminService(repository, governance.service, createRuntimeStub());

    await expect(
      service.createConfigDraft(
        { actorId: 'admin-user' },
        {
          configuration: { CONFLUENCE_PASSWORD: 'never-store-this' },
          description: '非法配置',
          changeSummary: '安全测试',
        },
      ),
    ).rejects.toThrow('禁止写入数据库');
  });

  it('rolls back by creating a new active version and preserving immutable history', async () => {
    const repository = new MemoryAdminRepository();
    const governance = createGovernanceStub();
    const service = new AdminService(repository, governance.service, createRuntimeStub());
    const first = await service.createConfigDraft(
      { actorId: 'admin-user' },
      {
        configuration: { 'alerts.queueWaitingThreshold': 20 },
        description: '版本一',
        changeSummary: '初始版本',
      },
    );
    await service.publishConfigDraft(
      { actorId: 'admin-user' },
      first.id,
      configPublishConfirmation(first.version),
    );
    const second = await service.createConfigDraft(
      { actorId: 'admin-user' },
      {
        configuration: { 'alerts.queueWaitingThreshold': 40 },
        description: '版本二',
        changeSummary: '调整阈值',
      },
    );
    await service.publishConfigDraft(
      { actorId: 'admin-user' },
      second.id,
      configPublishConfirmation(second.version),
    );

    const rolledBack = await service.rollbackConfigVersion({ actorId: 'admin-user' }, first.id, {
      confirmation: configRollbackConfirmation(first.version),
      changeSummary: '回滚验收',
    });

    expect(rolledBack).toMatchObject({ status: 'active', version: 3, baseVersion: 1 });
    expect(rolledBack.configuration['alerts.queueWaitingThreshold']).toBe(20);
  });
});

const taskId = '20000000-0000-4000-8000-000000000001';

class MemoryAdminRepository implements AdminRepositoryPort {
  private alerts: OperationalAlertRecord[] = [];
  private operations: AdminOperationRecord[] = [];
  private configVersions: PlatformConfigVersionRecord[] = [];

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
      configVersions: this.configVersions.map((item) => ({ ...item })),
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

  public getConfigVersion(configId: string): Promise<PlatformConfigVersionRecord | undefined> {
    return Promise.resolve(this.configVersions.find((item) => item.id === configId));
  }

  public getActiveConfigVersion(): Promise<PlatformConfigVersionRecord | undefined> {
    return Promise.resolve(this.configVersions.find((item) => item.status === 'active'));
  }

  public createConfigDraft(
    input: Parameters<AdminRepositoryPort['createConfigDraft']>[0],
  ): Promise<PlatformConfigVersionRecord> {
    const version = this.configVersions.length + 1;
    const record: PlatformConfigVersionRecord = {
      id: `50000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
      version,
      checksum: input.checksum,
      status: 'draft',
      configuration: input.configuration,
      description: input.description,
      changeSummary: input.changeSummary,
      ...(input.baseVersion ? { baseVersion: input.baseVersion } : {}),
      validation: input.validation,
      createdBy: input.createdBy,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedBy: input.createdBy,
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    this.configVersions.unshift(record);
    return Promise.resolve(record);
  }

  public updateConfigDraft(
    input: Parameters<AdminRepositoryPort['updateConfigDraft']>[0],
  ): Promise<PlatformConfigVersionRecord> {
    const record = this.configVersions.find((item) => item.id === input.configId);
    if (!record || record.status !== 'draft') throw new Error('Draft not found.');
    Object.assign(record, {
      checksum: input.checksum,
      configuration: input.configuration,
      description: input.description,
      changeSummary: input.changeSummary,
      validation: input.validation,
      updatedBy: input.updatedBy,
    });
    return Promise.resolve(record);
  }

  public publishConfigDraft(
    configId: string,
    actorId: string,
  ): Promise<PlatformConfigVersionRecord> {
    const record = this.configVersions.find((item) => item.id === configId);
    if (!record) throw new Error('Draft not found.');
    for (const item of this.configVersions) {
      if (item.status === 'active') item.status = 'superseded';
    }
    Object.assign(record, {
      status: 'active',
      activatedBy: actorId,
      activatedAt: '2026-08-26T00:00:01.000Z',
    });
    return Promise.resolve(record);
  }

  public rollbackConfigVersion(
    input: Parameters<AdminRepositoryPort['rollbackConfigVersion']>[0],
  ): Promise<PlatformConfigVersionRecord> {
    const source = this.configVersions.find((item) => item.id === input.sourceConfigId);
    if (!source) throw new Error('Source not found.');
    for (const item of this.configVersions) {
      if (item.status === 'active') item.status = 'superseded';
    }
    const version = this.configVersions.length + 1;
    const record: PlatformConfigVersionRecord = {
      ...source,
      id: `50000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
      version,
      status: 'active',
      baseVersion: source.version,
      changeSummary: input.changeSummary,
      createdBy: input.actorId,
      createdAt: '2026-08-26T00:00:02.000Z',
      updatedBy: input.actorId,
      updatedAt: '2026-08-26T00:00:02.000Z',
      activatedBy: input.actorId,
      activatedAt: '2026-08-26T00:00:02.000Z',
    };
    this.configVersions.unshift(record);
    return Promise.resolve(record);
  }
}

function createGovernanceStub(roleIds: string[] = ['administrator']) {
  const authorizeAdminRead = vi.fn(() => roleIds);
  const authorizeAdminOperation = vi.fn(() => ['operator']);
  const authorizeAlertManagement = vi.fn(() => ['operator']);
  const authorizeConfigManagement = vi.fn(() => roleIds);
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
      authorizeConfigManagement,
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
    getIntegrations: () => Promise.resolve([]),
  };
}

describe('P7 integration status aggregation', () => {
  it('uses the Windows Worker as the source of truth for enterprise integrations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            service: 'windows-worker',
            checkedAt: '2026-08-26T05:00:00.000Z',
            integrations: [
              { id: 'feishu', configured: true, resourceCount: 4 },
              { id: 'gitlab', configured: true, resourceCount: 11 },
              { id: 'confluence', configured: true, resourceCount: 2 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const runtime = createAdminRuntime({
      queue: { getSnapshot: () => Promise.resolve(createRuntimeStubSnapshot()) },
      environment: {
        WINDOWS_WORKER_URL: 'http://127.0.0.1:3200',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'protected',
        API_AGENT_ENABLED: 'false',
      },
    });

    try {
      await expect(runtime.getIntegrations()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'gitlab', status: 'configured', resourceCount: 11 }),
          expect.objectContaining({ id: 'confluence', status: 'configured', resourceCount: 2 }),
          expect.objectContaining({ id: 'feishu', status: 'configured', resourceCount: 4 }),
        ]),
      );
      expect(runtime.getConfigSummary().map((item) => item.key)).not.toEqual(
        expect.arrayContaining(['GITLAB_TOKEN', 'CONFLUENCE_CLI_WRAPPER']),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports Worker-owned integrations as offline when the status endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    const runtime = createAdminRuntime({
      queue: { getSnapshot: () => Promise.resolve(createRuntimeStubSnapshot()) },
      environment: { WINDOWS_WORKER_URL: 'http://127.0.0.1:3200' },
    });

    try {
      const integrations = await runtime.getIntegrations();
      expect(integrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'gitlab', status: 'offline' }),
          expect.objectContaining({ id: 'confluence', status: 'offline' }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function createRuntimeStubSnapshot() {
  return {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    deadLettered: 0,
  };
}
