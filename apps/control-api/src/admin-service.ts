import { randomUUID } from 'node:crypto';

import type { GovernanceRoleBinding, RiskLevel } from '@feishu-agent/contracts';
import type {
  AdminAction,
  AdminDatabaseSnapshot,
  AdminOperationRecord,
  AdminTaskTrace,
  OperationalAlertInput,
} from '@feishu-agent/database';
import { redactSensitive } from '@feishu-agent/integrations';

import { GovernanceAuthorizationError, type GovernanceService } from './governance-service.js';
import type { TaskCoordinator } from './task-coordinator.js';
import type { TaskQueueSnapshot } from './task-queue.js';

export interface AdminRepositoryPort {
  getSnapshot(limit?: number): Promise<AdminDatabaseSnapshot>;
  getTaskTrace(taskId: string): Promise<AdminTaskTrace | undefined>;
  reconcileAlerts(alerts: readonly OperationalAlertInput[]): Promise<void>;
  acknowledgeAlert(alertId: string, actorId: string): Promise<boolean>;
  createOperation(input: {
    action: AdminAction;
    targetType: string;
    targetId: string;
    riskLevel: RiskLevel;
    requestedBy: string;
    confirmation: string;
    status: AdminOperationRecord['status'];
  }): Promise<AdminOperationRecord>;
  finishOperation(input: {
    operationId: string;
    status: 'succeeded' | 'failed' | 'rejected';
    result?: Record<string, unknown>;
    errorCode?: string;
  }): Promise<AdminOperationRecord>;
}

export interface AdminRuntimePort {
  getQueueSnapshot(): Promise<TaskQueueSnapshot>;
  getServiceHealth(): Promise<ServiceHealth[]>;
  getConfigSummary(): ConfigSummaryItem[];
  getIntegrations(): IntegrationStatus[];
}

export interface ServiceHealth {
  service: string;
  status: 'ok' | 'degraded' | 'offline';
  version?: string;
  latencyMs: number;
  checkedAt: string;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface ConfigSummaryItem {
  group: string;
  key: string;
  configured: boolean;
  source: 'default' | 'environment' | 'credential_reference';
  restartRequired: boolean;
}

export interface IntegrationStatus {
  id: string;
  name: string;
  status: 'ready' | 'disabled' | 'incomplete';
  mode: string;
  resourceCount?: number;
  detail: string;
}

export interface AdminSnapshot {
  phase: 'P6';
  generatedAt: string;
  viewer: { roleIds: string[]; capabilities: AdminConsoleCapabilities };
  summary: {
    totalTasks: number;
    activeTasks: number;
    failedTasks: number;
    pendingApprovals: number;
    openAlerts: number;
    criticalAlerts: number;
    tokensUsed: number;
    costMicrosUsed: number;
  };
  queue: TaskQueueSnapshot;
  services: ServiceHealth[];
  integrations: IntegrationStatus[];
  configuration: ConfigSummaryItem[];
  data: AdminDatabaseSnapshot;
}

interface AdminIdentity {
  actorId: string;
  groupIds?: string[];
}

export const adminPageIds = [
  'overview',
  'tasks',
  'runtime',
  'executors',
  'integrations',
  'approvals',
  'access',
  'budgets',
  'trace',
  'alerts',
  'config',
  'delivery',
  'operations',
  'guide',
] as const;
export type AdminPageId = (typeof adminPageIds)[number];

export interface AdminConsoleCapabilities {
  isSuperAdmin: boolean;
  allowedPages: AdminPageId[];
  canManageAccess: boolean;
  canOperate: boolean;
  canManageAlerts: boolean;
  canDecideApprovals: boolean;
  canManageBudgets: boolean;
  canExportAudit: boolean;
  canManageReleases: boolean;
  canManageBackups: boolean;
  canManageConfig: boolean;
}

export interface AdminThresholds {
  queueWaiting: number;
  budgetPercent: number;
}

export interface LocalAdminSessionConfig {
  enabled: boolean;
  actorId?: string;
  ttlMs?: number;
  manualIdentityEnabled?: boolean;
}

export interface LocalAdminSession {
  accessToken: string;
  expiresAt: string;
  displayName: string;
  roleIds: string[];
  provider: 'local' | 'feishu';
  capabilities: AdminConsoleCapabilities;
}

export type AdminSessionView = Omit<LocalAdminSession, 'accessToken'>;

interface StoredAdminSession {
  actorId: string;
  expiresAt: number;
  displayName: string;
  provider: LocalAdminSession['provider'];
}

const actionSpecifications: Record<
  AdminAction,
  { label: string; targetType: string; riskLevel: RiskLevel; executable: boolean }
> = {
  cancel: { label: '取消任务', targetType: 'task', riskLevel: 'medium', executable: true },
  retry: { label: '重试任务', targetType: 'task', riskLevel: 'high', executable: false },
  cleanup: { label: '清理资源', targetType: 'workspace', riskLevel: 'high', executable: false },
  restart: { label: '重启服务', targetType: 'service', riskLevel: 'critical', executable: false },
  rollback: { label: '回滚版本', targetType: 'release', riskLevel: 'critical', executable: false },
};

export class AdminValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AdminValidationError';
  }
}

export class AdminService {
  private readonly sessions = new Map<string, StoredAdminSession>();

  public constructor(
    private readonly repository: AdminRepositoryPort,
    private readonly governance: GovernanceService,
    private readonly runtime: AdminRuntimePort,
    private readonly coordinator?: Pick<TaskCoordinator, 'cancel'>,
    private readonly thresholds: AdminThresholds = { queueWaiting: 20, budgetPercent: 80 },
    private readonly localSessionConfig: LocalAdminSessionConfig = { enabled: false },
  ) {}

  public createLocalSession(remoteAddress: string): LocalAdminSession | undefined {
    const actorId = this.localSessionConfig.actorId?.trim();
    if (!this.localSessionConfig.enabled || !actorId || !isLoopbackAddress(remoteAddress)) {
      return undefined;
    }
    return this.issueSession({
      actorId,
      displayName: '本机管理员',
      provider: 'local',
      ttlMs: this.localSessionConfig.ttlMs ?? 8 * 60 * 60 * 1_000,
    });
  }

  public resolveLocalSession(accessToken: string): AdminIdentity | undefined {
    return this.resolveAdminSession(accessToken);
  }

  public createFeishuSession(input: {
    actorId: string;
    displayName: string;
    ttlMs: number;
    requireSuperAdmin?: boolean;
  }): LocalAdminSession {
    return this.issueSession({ ...input, provider: 'feishu' });
  }

  public resolveAdminSession(accessToken: string): AdminIdentity | undefined {
    const session = this.sessions.get(accessToken);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(accessToken);
      return undefined;
    }
    return { actorId: session.actorId };
  }

  public describeSession(accessToken: string): AdminSessionView | undefined {
    const identity = this.resolveAdminSession(accessToken);
    const session = this.sessions.get(accessToken);
    if (!identity || !session) return undefined;
    const { roleIds, capabilities } = this.consoleAccess(identity);
    return {
      expiresAt: new Date(session.expiresAt).toISOString(),
      displayName: session.displayName,
      roleIds,
      provider: session.provider,
      capabilities,
    };
  }

  public revokeSession(accessToken: string): boolean {
    return this.sessions.delete(accessToken);
  }

  public getAccessConfig(): { localBootstrapEnabled: boolean; manualIdentityEnabled: boolean } {
    return {
      localBootstrapEnabled: this.localSessionConfig.enabled,
      manualIdentityEnabled: this.localSessionConfig.manualIdentityEnabled ?? false,
    };
  }

  public canUseManualIdentity(remoteAddress: string): boolean {
    return (
      (this.localSessionConfig.manualIdentityEnabled ?? false) && isLoopbackAddress(remoteAddress)
    );
  }

  public async snapshot(identity: AdminIdentity, limit = 50): Promise<AdminSnapshot> {
    const { roleIds, capabilities } = this.consoleAccess(identity);
    const [initialData, queue, services] = await Promise.all([
      this.repository.getSnapshot(limit),
      this.runtime.getQueueSnapshot(),
      this.runtime.getServiceHealth(),
    ]);
    await this.repository.reconcileAlerts(this.evaluateAlerts(initialData, queue, services));
    const fullData = await this.repository.getSnapshot(limit);
    const data = filterSnapshotData(fullData, capabilities.allowedPages);
    const snapshot: AdminSnapshot = {
      phase: 'P6',
      generatedAt: new Date().toISOString(),
      viewer: { roleIds, capabilities },
      summary: summarize(fullData, queue),
      queue,
      services,
      integrations: capabilities.allowedPages.includes('integrations')
        ? this.runtime.getIntegrations()
        : [],
      configuration: capabilities.allowedPages.includes('config')
        ? this.runtime.getConfigSummary()
        : [],
      data,
    };
    return redactSensitive(snapshot) as AdminSnapshot;
  }

  public async taskTrace(
    identity: AdminIdentity,
    taskId: string,
  ): Promise<AdminTaskTrace | undefined> {
    const { capabilities } = this.consoleAccess(identity);
    if (!capabilities.allowedPages.includes('trace')) {
      throw new GovernanceAuthorizationError(
        'ADMIN_PAGE_NOT_AUTHORIZED',
        '当前飞书身份没有日志与 Trace 页面权限。',
      );
    }
    const trace = await this.repository.getTaskTrace(taskId);
    return trace ? (redactSensitive(trace) as AdminTaskTrace) : undefined;
  }

  public async requestAction(
    identity: AdminIdentity,
    input: { action: AdminAction; targetType: string; targetId: string; confirmation: string },
  ): Promise<AdminOperationRecord> {
    const roleIds = this.governance.authorizeAdminOperation({
      userId: identity.actorId,
      groupIds: identity.groupIds,
    });
    const specification = actionSpecifications[input.action];
    if (input.targetType !== specification.targetType) {
      throw new AdminValidationError(
        `${input.action} requires targetType=${specification.targetType}.`,
      );
    }
    const expected = confirmationText(input.action, input.targetId);
    if (input.confirmation !== expected) {
      throw new AdminValidationError(`Confirmation must exactly match: ${expected}`);
    }
    const status = specification.executable ? 'executing' : 'pending_approval';
    const operation = await this.repository.createOperation({
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      riskLevel: specification.riskLevel,
      requestedBy: identity.actorId,
      confirmation: input.confirmation,
      status,
    });
    const correlationId = randomUUID();
    await this.governance.recordAdminAudit({
      correlationId,
      actorId: identity.actorId,
      action: `admin.${input.action}`,
      resourceType: input.targetType,
      resourceId: input.targetId,
      outcome: status,
      details: { operationId: operation.id, riskLevel: specification.riskLevel, roleIds },
    });
    if (!specification.executable) {
      return operation;
    }
    if (input.action !== 'cancel' || !this.coordinator) {
      return this.repository.finishOperation({
        operationId: operation.id,
        status: 'failed',
        errorCode: 'ACTION_HANDLER_UNAVAILABLE',
      });
    }
    try {
      const result = await this.coordinator.cancel(input.targetId);
      const succeeded = result !== 'not_found';
      const completed = await this.repository.finishOperation({
        operationId: operation.id,
        status: succeeded ? 'succeeded' : 'failed',
        result: { taskStatus: result },
        ...(succeeded ? {} : { errorCode: 'TASK_NOT_FOUND' }),
      });
      await this.governance.recordAdminAudit({
        correlationId,
        actorId: identity.actorId,
        action: 'admin.cancel.complete',
        resourceType: 'task',
        resourceId: input.targetId,
        outcome: completed.status,
        details: { operationId: operation.id, taskStatus: result },
      });
      return completed;
    } catch (error: unknown) {
      const completed = await this.repository.finishOperation({
        operationId: operation.id,
        status: 'failed',
        errorCode: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      });
      await this.governance.recordAdminAudit({
        correlationId,
        actorId: identity.actorId,
        action: 'admin.cancel.complete',
        resourceType: 'task',
        resourceId: input.targetId,
        outcome: 'failed',
        details: { operationId: operation.id },
      });
      return completed;
    }
  }

  public async upsertRoleBinding(
    identity: AdminIdentity,
    binding: GovernanceRoleBinding,
  ): Promise<{ saved: true }> {
    validateManagedRole(binding.roleId);
    await this.governance.upsertRoleBinding(
      { userId: identity.actorId, groupIds: identity.groupIds },
      binding,
    );
    return { saved: true };
  }

  public async deleteRoleBinding(
    identity: AdminIdentity,
    binding: GovernanceRoleBinding,
  ): Promise<{ result: 'deleted' | 'protected' | 'not_found' }> {
    validateManagedRole(binding.roleId);
    const result = await this.governance.deleteRoleBinding(
      { userId: identity.actorId, groupIds: identity.groupIds },
      binding,
    );
    return { result: result.result };
  }

  public async acknowledgeAlert(
    identity: AdminIdentity,
    alertId: string,
  ): Promise<{ acknowledged: boolean }> {
    const roleIds = this.governance.authorizeAlertManagement({
      userId: identity.actorId,
      groupIds: identity.groupIds,
    });
    const acknowledged = await this.repository.acknowledgeAlert(alertId, identity.actorId);
    await this.governance.recordAdminAudit({
      correlationId: randomUUID(),
      actorId: identity.actorId,
      action: 'alert.acknowledge',
      resourceType: 'operational_alert',
      resourceId: alertId,
      outcome: acknowledged ? 'succeeded' : 'not_found_or_terminal',
      details: { roleIds },
    });
    return { acknowledged };
  }

  private evaluateAlerts(
    data: AdminDatabaseSnapshot,
    queue: TaskQueueSnapshot,
    services: ServiceHealth[],
  ): OperationalAlertInput[] {
    const alerts: OperationalAlertInput[] = [];
    if (queue.waiting >= this.thresholds.queueWaiting) {
      alerts.push({
        key: 'queue:waiting:high',
        severity: 'warning',
        category: 'queue',
        title: '任务队列积压',
        message: `等待任务达到 ${queue.waiting}，阈值为 ${this.thresholds.queueWaiting}。`,
        source: 'bullmq',
        details: { waiting: queue.waiting, threshold: this.thresholds.queueWaiting },
      });
    }
    for (const service of services.filter((item) => item.status !== 'ok')) {
      alerts.push({
        key: `service:${service.service}:${service.status}`,
        severity: service.status === 'offline' ? 'critical' : 'warning',
        category: 'service',
        title: `${service.service} ${service.status === 'offline' ? '离线' : '降级'}`,
        message: `${service.service} 最近一次健康检查状态为 ${service.status}。`,
        source: service.service,
        details: { status: service.status, latencyMs: service.latencyMs },
      });
    }
    const failed = data.taskCounts.failed ?? 0;
    if (failed > 0) {
      alerts.push({
        key: 'tasks:failed:present',
        severity: 'warning',
        category: 'task',
        title: '存在失败任务',
        message: `当前累计失败任务 ${failed} 个，请通过 Trace 定位。`,
        source: 'control-api',
        details: { failed },
      });
    }
    const modelFailures = data.executorRuns.filter(
      (run) =>
        scalarText(run.status).toLowerCase() === 'failed' &&
        ['api_agent', 'codex_cli'].includes(
          scalarText(run.executor ?? run.requestedExecutor).toLowerCase(),
        ),
    );
    if (modelFailures.length > 0) {
      alerts.push({
        key: 'executor:model:failed',
        severity: 'critical',
        category: 'model',
        title: '模型执行失败',
        message: `最近查询范围内有 ${modelFailures.length} 次模型执行失败，请检查执行器日志与 Trace。`,
        source: 'executor-runtime',
        details: { failedRuns: modelFailures.length },
      });
    }
    for (const budget of data.budgets) {
      const tokenLimit = Number(budget.tokenLimit ?? 0);
      const tokensUsed = Number(budget.tokensUsed ?? 0);
      const percent = tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : 0;
      if (percent >= this.thresholds.budgetPercent) {
        const scopeType = scalarText(budget.scopeType, 'unknown');
        const scopeId = scalarText(budget.scopeId, 'unknown');
        const period = scalarText(budget.period);
        alerts.push({
          key: `budget:${scopeType}:${scopeId}:${period}`,
          severity: percent >= 100 ? 'critical' : 'warning',
          category: 'budget',
          title: 'Token 预算接近或达到上限',
          message: `${scopeType}/${scopeId} 已使用 ${percent}% Token 预算。`,
          source: 'governance',
          details: { scopeType, percent },
        });
      }
    }
    return alerts;
  }

  private issueSession(input: {
    actorId: string;
    displayName: string;
    provider: LocalAdminSession['provider'];
    ttlMs: number;
    requireSuperAdmin?: boolean;
  }): LocalAdminSession {
    const { roleIds, capabilities } = this.consoleAccess({ actorId: input.actorId });
    if (input.requireSuperAdmin && !capabilities.isSuperAdmin) {
      throw new GovernanceAuthorizationError(
        'FEISHU_SUPER_ADMIN_REQUIRED',
        '当前飞书用户不是平台超级管理员。',
      );
    }
    const expiresAt = Date.now() + input.ttlMs;
    const accessToken = `${randomUUID()}${randomUUID().replaceAll('-', '')}`;
    this.pruneSessions();
    if (this.sessions.size >= 256) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(accessToken, {
      actorId: input.actorId,
      expiresAt,
      displayName: input.displayName,
      provider: input.provider,
    });
    return {
      accessToken,
      expiresAt: new Date(expiresAt).toISOString(),
      displayName: input.displayName,
      roleIds,
      provider: input.provider,
      capabilities,
    };
  }

  private consoleAccess(identity: AdminIdentity): {
    roleIds: string[];
    capabilities: AdminConsoleCapabilities;
  } {
    const roleIds = this.governance.authorizeAdminRead({
      userId: identity.actorId,
      groupIds: identity.groupIds,
    });
    return {
      roleIds,
      capabilities: buildConsoleCapabilities(
        roleIds,
        this.governance.capabilities({
          userId: identity.actorId,
          groupIds: identity.groupIds,
        }),
      ),
    };
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export function confirmationText(action: AdminAction, targetId: string): string {
  return `确认${actionSpecifications[action].label}:${targetId}`;
}

function buildConsoleCapabilities(
  roleIds: string[],
  governance: ReturnType<GovernanceService['capabilities']>,
): AdminConsoleCapabilities {
  const isSuperAdmin = roleIds.includes('administrator');
  if (isSuperAdmin) {
    return {
      isSuperAdmin: true,
      allowedPages: [...adminPageIds],
      canManageAccess: true,
      canOperate: true,
      canManageAlerts: true,
      canDecideApprovals: true,
      canManageBudgets: true,
      canExportAudit: true,
      canManageReleases: true,
      canManageBackups: true,
      canManageConfig: true,
    };
  }

  const allowedPages = new Set<AdminPageId>(['overview', 'guide']);
  if (roleIds.includes('reader')) {
    for (const page of ['tasks', 'runtime', 'executors', 'integrations'] as const) {
      allowedPages.add(page);
    }
  }
  if (roleIds.includes('operator')) {
    for (const page of [
      'tasks',
      'runtime',
      'executors',
      'integrations',
      'trace',
      'alerts',
      'operations',
    ] as const) {
      allowedPages.add(page);
    }
  }
  if (governance.canDecideApprovals) allowedPages.add('approvals');
  if (governance.canExportAudit) allowedPages.add('trace');
  if (governance.canManageBudgets) allowedPages.add('budgets');
  if (governance.canManageAlerts) allowedPages.add('alerts');
  if (governance.canManageAccess) allowedPages.add('access');
  if (governance.canManageConfig) allowedPages.add('config');
  if (governance.canManageReleases || governance.canManageBackups) {
    allowedPages.add('delivery');
  }
  if (governance.canOperateAdmin) allowedPages.add('operations');

  return {
    isSuperAdmin: false,
    allowedPages: adminPageIds.filter((page) => allowedPages.has(page)),
    canManageAccess: governance.canManageAccess,
    canOperate: governance.canOperateAdmin,
    canManageAlerts: governance.canManageAlerts,
    canDecideApprovals: governance.canDecideApprovals,
    canManageBudgets: governance.canManageBudgets,
    canExportAudit: governance.canExportAudit,
    canManageReleases: governance.canManageReleases,
    canManageBackups: governance.canManageBackups,
    canManageConfig: governance.canManageConfig,
  };
}

function filterSnapshotData(
  data: AdminDatabaseSnapshot,
  allowedPages: readonly AdminPageId[],
): AdminDatabaseSnapshot {
  const allowed = new Set(allowedPages);
  return {
    taskCounts: data.taskCounts,
    tasks:
      allowed.has('tasks') || allowed.has('trace') || allowed.has('operations') ? data.tasks : [],
    conversations: allowed.has('tasks') ? data.conversations : [],
    approvals: allowed.has('approvals') ? data.approvals : [],
    executorRuns: allowed.has('executors') || allowed.has('trace') ? data.executorRuns : [],
    roles: allowed.has('access') ? data.roles : [],
    roleBindings: allowed.has('access') ? data.roleBindings : [],
    budgets: allowed.has('budgets') ? data.budgets : [],
    auditEvents: allowed.has('trace') ? data.auditEvents : [],
    alerts: data.alerts,
    operations: allowed.has('operations') ? data.operations : [],
    releases: allowed.has('delivery') ? data.releases : [],
    backups: allowed.has('delivery') ? data.backups : [],
    configVersions: allowed.has('delivery') || allowed.has('config') ? data.configVersions : [],
  };
}

function validateManagedRole(roleId: string): void {
  if (!['reader', 'operator', 'approver', 'auditor', 'administrator'].includes(roleId)) {
    throw new AdminValidationError(`不支持管理角色 ${roleId}。`);
  }
}

export function createAdminRuntime(input: {
  queue: { getSnapshot(): Promise<TaskQueueSnapshot> };
  environment?: NodeJS.ProcessEnv;
}): AdminRuntimePort {
  const environment = input.environment ?? process.env;
  const probeTimeoutMs = readPositiveInteger(environment.ADMIN_SERVICE_PROBE_TIMEOUT_MS, 2_500);
  return {
    getQueueSnapshot: () => input.queue.getSnapshot(),
    getServiceHealth: () =>
      Promise.all([
        Promise.resolve({
          service: 'control-api',
          status: 'ok' as const,
          version: '0.1.0',
          latencyMs: 0,
          checkedAt: new Date().toISOString(),
          checks: [],
        }),
        probeService(
          'feishu-gateway',
          `${environment.FEISHU_GATEWAY_INTERNAL_URL ?? 'http://127.0.0.1:3100'}/health/ready`,
          probeTimeoutMs,
        ),
        probeService(
          'windows-worker',
          `${environment.WINDOWS_WORKER_URL ?? 'http://127.0.0.1:3200'}/health/ready`,
          probeTimeoutMs,
        ),
      ]),
    getConfigSummary: () => buildConfigSummary(environment),
    getIntegrations: () => buildIntegrations(environment),
  };
}

async function probeService(
  service: string,
  url: string,
  timeoutMs: number,
): Promise<ServiceHealth> {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const value = (await response.json()) as {
      status?: 'ok' | 'degraded';
      version?: string;
      checkedAt?: string;
      checks?: Array<{ name: string; ok: boolean; detail?: string }>;
    };
    return {
      service,
      status: response.ok && value.status === 'ok' ? 'ok' : 'degraded',
      ...(value.version ? { version: value.version } : {}),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      checkedAt: value.checkedAt ?? new Date().toISOString(),
      checks: value.checks ?? [],
    };
  } catch {
    return {
      service,
      status: 'offline',
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      checkedAt: new Date().toISOString(),
      checks: [{ name: 'http', ok: false, detail: 'Health endpoint unavailable.' }],
    };
  }
}

function buildConfigSummary(environment: NodeJS.ProcessEnv): ConfigSummaryItem[] {
  const definitions: Array<[string, string, boolean]> = [
    ['运行时', 'DATABASE_URL', true],
    ['运行时', 'REDIS_URL', true],
    ['飞书', 'FEISHU_APP_ID', true],
    ['飞书', 'FEISHU_APP_SECRET', true],
    ['GitLab', 'GITLAB_BASE_URL', false],
    ['GitLab', 'GITLAB_TOKEN', true],
    ['Confluence', 'CONFLUENCE_CLI_WRAPPER', false],
    ['执行器', 'WINDOWS_WORKER_URL', false],
    ['执行器', 'API_AGENT_ENABLED', true],
    ['管理台', 'ADMIN_LOCAL_BOOTSTRAP_ENABLED', true],
    ['告警', 'ADMIN_ALERT_QUEUE_WAITING_THRESHOLD', false],
    ['告警', 'ADMIN_ALERT_BUDGET_PERCENT_THRESHOLD', false],
    ['告警', 'ADMIN_SERVICE_PROBE_TIMEOUT_MS', false],
  ];
  return definitions.map(([group, key, restartRequired]) => {
    const value = environment[key]?.trim() ?? '';
    return {
      group,
      key,
      configured: Boolean(value),
      source: value.startsWith('wincred://')
        ? 'credential_reference'
        : value
          ? 'environment'
          : 'default',
      restartRequired,
    };
  });
}

function buildIntegrations(environment: NodeJS.ProcessEnv): IntegrationStatus[] {
  return [
    {
      id: 'feishu',
      name: '飞书开放平台',
      status: environment.FEISHU_APP_ID && environment.FEISHU_APP_SECRET ? 'ready' : 'incomplete',
      mode: 'WSS + OpenAPI',
      resourceCount:
        countCsv(environment.FEISHU_ALLOWED_DOCUMENT_IDS) +
        countCsv(environment.FEISHU_ALLOWED_BITABLE_APP_TOKENS) +
        countCsv(environment.FEISHU_ALLOWED_CHAT_IDS) +
        countCsv(environment.FEISHU_ALLOWED_USER_IDS),
      detail: '事件长连接、文档、多维表格、群组与通讯录只读。',
    },
    {
      id: 'gitlab',
      name: '企业 GitLab',
      status: environment.GITLAB_BASE_URL && environment.GITLAB_TOKEN ? 'ready' : 'incomplete',
      mode: 'read_api',
      resourceCount: countCsv(environment.GITLAB_ALLOWED_PROJECTS),
      detail: '项目、MR、差异、流水线和日志只读。',
    },
    {
      id: 'confluence',
      name: '企业 Confluence',
      status: environment.CONFLUENCE_CLI_WRAPPER ? 'ready' : 'incomplete',
      mode: 'CLI + REST',
      resourceCount:
        countCsv(environment.CONFLUENCE_ALLOWED_SPACE_KEYS) +
        countCsv(environment.CONFLUENCE_ALLOWED_PAGE_IDS),
      detail: 'CQL、页面、附件元数据和评论只读。',
    },
    {
      id: 'api-agent',
      name: 'API/ReAct',
      status: environment.API_AGENT_ENABLED?.toLowerCase() === 'true' ? 'ready' : 'disabled',
      mode: 'Feature flag',
      detail: '按当前决策保持关闭，不参与路由、就绪或回退。',
    },
  ];
}

function summarize(
  data: AdminDatabaseSnapshot,
  queue: TaskQueueSnapshot,
): AdminSnapshot['summary'] {
  const totalTasks = Object.values(data.taskCounts).reduce((sum, value) => sum + value, 0);
  const pendingApprovals = data.approvals.filter((item) => item.status === 'pending').length;
  const openAlerts = data.alerts.filter((item) => item.status !== 'resolved');
  const budgetTotals = data.budgets.reduce<{ tokens: number; cost: number }>(
    (totals, item) => ({
      tokens: totals.tokens + Number(item.tokensUsed ?? 0),
      cost: totals.cost + Number(item.costMicrosUsed ?? 0),
    }),
    { tokens: 0, cost: 0 },
  );
  return {
    totalTasks,
    activeTasks: (data.taskCounts.queued ?? 0) + (data.taskCounts.running ?? 0) + queue.active,
    failedTasks: data.taskCounts.failed ?? 0,
    pendingApprovals,
    openAlerts: openAlerts.length,
    criticalAlerts: openAlerts.filter((item) => item.severity === 'critical').length,
    tokensUsed: budgetTotals.tokens,
    costMicrosUsed: budgetTotals.cost,
  };
}

function countCsv(value: string | undefined): number {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ).size;
}

export function readAdminThresholds(environment: NodeJS.ProcessEnv = process.env): AdminThresholds {
  return {
    queueWaiting: readPositiveInteger(environment.ADMIN_ALERT_QUEUE_WAITING_THRESHOLD, 20),
    budgetPercent: readPositiveInteger(environment.ADMIN_ALERT_BUDGET_PERCENT_THRESHOLD, 80),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function scalarText(value: unknown, fallback = ''): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return fallback;
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}
