export interface QueueSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  deadLettered: number;
}

export interface ServiceHealth {
  service: string;
  status: 'ok' | 'degraded' | 'offline';
  version?: string;
  latencyMs: number;
  checkedAt: string;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface IntegrationStatus {
  id: string;
  name: string;
  status: 'ready' | 'configured' | 'disabled' | 'incomplete' | 'offline';
  mode: string;
  resourceCount?: number;
  detail: string;
  source?: 'control-api' | 'windows-worker' | 'combined';
  checkedAt?: string;
}

export interface ConfigurationItem {
  group: string;
  key: string;
  configured: boolean;
  source: 'default' | 'environment' | 'credential_reference';
  restartRequired: boolean;
}

export interface ManagedConfigCatalogItem {
  key: string;
  group: string;
  label: string;
  description: string;
  minimum: number;
  maximum: number;
  defaultValue: number;
  unit: string;
}

export type ManagedConfiguration = Record<string, number>;

export interface ConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  validatedAt: string;
}

export interface ConfigVersion {
  id: string;
  version: number;
  checksum: string;
  status: 'draft' | 'active' | 'superseded';
  configuration: ManagedConfiguration;
  description: string;
  changeSummary: string;
  baseVersion?: number;
  validation: ConfigValidation;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
  activatedBy?: string;
  activatedAt?: string;
  supersededAt?: string;
}

export interface AlertRecord {
  id: string;
  key: string;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  source: string;
  status: 'open' | 'acknowledged' | 'resolved';
  correlationId?: string;
  details: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AdminOperation {
  id: string;
  action: 'cancel' | 'retry' | 'cleanup' | 'restart' | 'rollback';
  targetType: string;
  targetId: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requestedBy: string;
  status: 'pending_approval' | 'executing' | 'succeeded' | 'failed' | 'rejected';
  result: Record<string, unknown>;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type AdminPageId =
  | 'overview'
  | 'tasks'
  | 'runtime'
  | 'executors'
  | 'integrations'
  | 'approvals'
  | 'access'
  | 'budgets'
  | 'trace'
  | 'alerts'
  | 'config'
  | 'delivery'
  | 'operations'
  | 'guide';

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

export interface AdminSnapshot {
  phase: 'P7';
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
  queue: QueueSnapshot;
  services: ServiceHealth[];
  integrations: IntegrationStatus[];
  configuration: ConfigurationItem[];
  managedConfiguration: {
    catalog: ManagedConfigCatalogItem[];
    effective: ManagedConfiguration;
    source: 'bootstrap' | 'database';
    activeVersion?: number;
  };
  data: {
    taskCounts: Record<string, number>;
    tasks: Array<Record<string, unknown>>;
    conversations: Array<Record<string, unknown>>;
    approvals: Array<Record<string, unknown>>;
    executorRuns: Array<Record<string, unknown>>;
    roles: Array<Record<string, unknown>>;
    roleBindings: Array<Record<string, unknown>>;
    budgets: Array<Record<string, unknown>>;
    auditEvents: Array<Record<string, unknown>>;
    alerts: AlertRecord[];
    operations: AdminOperation[];
    releases: Array<Record<string, unknown>>;
    backups: Array<Record<string, unknown>>;
    configVersions: ConfigVersion[];
  };
}

export interface TaskTrace {
  task: Record<string, unknown>;
  taskEvents: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  executorRuns: Array<Record<string, unknown>>;
  executorEvents: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
}

export interface AdminIdentity {
  actorId: string;
  groupIds: string;
  sessionToken?: string;
  displayName?: string;
  roleIds?: string[];
  capabilities?: AdminConsoleCapabilities;
  expiresAt?: string;
  provider?: 'feishu' | 'local' | 'manual';
}

export interface AdminAuthConfig {
  feishu: { enabled: boolean; redirectUri?: string };
  localBootstrapEnabled: boolean;
  manualIdentityEnabled: boolean;
}

export class AdminApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

const baseUrl =
  (import.meta.env.VITE_CONTROL_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function bootstrapLocalAdminSession(): Promise<AdminIdentity> {
  const response = await fetch(`${baseUrl}/v1/admin/session/local`, { method: 'POST' });
  if (!response.ok) {
    throw await toAdminApiError(response);
  }
  const session = (await response.json()) as {
    accessToken: string;
    expiresAt: string;
    displayName: string;
    roleIds: string[];
    provider: 'local';
    capabilities: AdminConsoleCapabilities;
  };
  return {
    actorId: '',
    groupIds: '',
    sessionToken: session.accessToken,
    displayName: session.displayName,
    roleIds: session.roleIds,
    capabilities: session.capabilities,
    expiresAt: session.expiresAt,
    provider: session.provider,
  };
}

export async function fetchAdminAuthConfig(): Promise<AdminAuthConfig> {
  const response = await fetch(`${baseUrl}/v1/admin/auth/config`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw await toAdminApiError(response);
  return (await response.json()) as AdminAuthConfig;
}

export async function restoreAdminSession(): Promise<AdminIdentity | undefined> {
  const response = await fetch(`${baseUrl}/v1/admin/session`, { credentials: 'same-origin' });
  if (response.status === 401) return undefined;
  if (!response.ok) throw await toAdminApiError(response);
  const session = (await response.json()) as {
    expiresAt: string;
    displayName: string;
    roleIds: string[];
    provider: 'feishu' | 'local';
    capabilities: AdminConsoleCapabilities;
  };
  return {
    actorId: '',
    groupIds: '',
    displayName: session.displayName,
    roleIds: session.roleIds,
    capabilities: session.capabilities,
    expiresAt: session.expiresAt,
    provider: session.provider,
  };
}

export function beginFeishuLogin(mode: 'standard' | 'super_admin' = 'standard'): void {
  window.location.assign(
    `${baseUrl}/v1/admin/auth/feishu/${mode === 'super_admin' ? 'super-admin/' : ''}start`,
  );
}

export async function logoutAdminSession(identity?: AdminIdentity): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/admin/session/logout`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: identity ? identityHeaders(identity) : {},
  });
  if (!response.ok) throw await toAdminApiError(response);
}

export function fetchAdminSnapshot(identity: AdminIdentity): Promise<AdminSnapshot> {
  return request<AdminSnapshot>('/v1/admin/snapshot?limit=100', identity);
}

export function fetchTaskTrace(identity: AdminIdentity, taskId: string): Promise<TaskTrace> {
  return request<TaskTrace>(`/v1/admin/tasks/${encodeURIComponent(taskId)}/trace`, identity);
}

export function acknowledgeAlert(
  identity: AdminIdentity,
  alertId: string,
): Promise<{ acknowledged: boolean }> {
  return request(`/v1/admin/alerts/${encodeURIComponent(alertId)}/acknowledge`, identity, {
    method: 'POST',
  });
}

export function submitAdminAction(
  identity: AdminIdentity,
  input: {
    action: AdminOperation['action'];
    targetType: string;
    targetId: string;
    confirmation: string;
  },
): Promise<AdminOperation> {
  return request('/v1/admin/actions', identity, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface RoleBindingInput {
  principalType: 'user' | 'group';
  principalId: string;
  roleId: 'reader' | 'operator' | 'approver' | 'auditor' | 'administrator';
}

export function upsertRoleBinding(
  identity: AdminIdentity,
  input: RoleBindingInput,
): Promise<{ saved: true }> {
  return request('/v1/admin/access/role-bindings', identity, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteRoleBinding(
  identity: AdminIdentity,
  input: RoleBindingInput,
): Promise<{ result: 'deleted' }> {
  return request('/v1/admin/access/role-bindings', identity, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function validateManagedConfig(
  identity: AdminIdentity,
  configuration: ManagedConfiguration,
): Promise<
  ConfigValidation & {
    configuration: ManagedConfiguration;
    catalog: ManagedConfigCatalogItem[];
  }
> {
  return request('/v1/admin/config/validate', identity, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configuration }),
  });
}

export function createConfigDraft(
  identity: AdminIdentity,
  input: {
    configuration: ManagedConfiguration;
    description: string;
    changeSummary: string;
    baseVersion?: number;
  },
): Promise<ConfigVersion> {
  return request('/v1/admin/config/versions', identity, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateConfigDraft(
  identity: AdminIdentity,
  configId: string,
  input: {
    configuration: ManagedConfiguration;
    description: string;
    changeSummary: string;
  },
): Promise<ConfigVersion> {
  return request(`/v1/admin/config/versions/${encodeURIComponent(configId)}`, identity, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function publishConfigDraft(
  identity: AdminIdentity,
  configId: string,
  confirmation: string,
): Promise<ConfigVersion> {
  return request(`/v1/admin/config/versions/${encodeURIComponent(configId)}/publish`, identity, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation }),
  });
}

export function rollbackConfigVersion(
  identity: AdminIdentity,
  configId: string,
  input: { confirmation: string; changeSummary: string },
): Promise<ConfigVersion> {
  return request(`/v1/admin/config/versions/${encodeURIComponent(configId)}/rollback`, identity, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function request<T>(
  path: string,
  identity: AdminIdentity,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...init.headers,
      ...identityHeaders(identity),
    },
  });
  if (!response.ok) {
    throw await toAdminApiError(response);
  }
  return (await response.json()) as T;
}

function identityHeaders(identity: AdminIdentity): Record<string, string> {
  if (identity.sessionToken) return { authorization: `Bearer ${identity.sessionToken}` };
  if (identity.provider === 'feishu') return {};
  return identity.actorId
    ? {
        'x-admin-actor-id': identity.actorId,
        ...(identity.groupIds.trim() ? { 'x-admin-group-ids': identity.groupIds } : {}),
      }
    : {};
}

async function toAdminApiError(response: Response): Promise<AdminApiError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  const code = body.error ?? 'CONTROL_API_ERROR';
  return new AdminApiError(
    localizedMessage(response.status, code, body.message),
    response.status,
    code,
  );
}

function localizedMessage(status: number, code: string, fallback?: string): string {
  if (code === 'ADMIN_READ_NOT_AUTHORIZED' || code === 'ADMIN_WRITE_NOT_AUTHORIZED') {
    return '当前飞书身份没有所需的平台角色，请联系超级管理员分配最小必要权限。';
  }
  if (code === 'ALERT_MANAGE_NOT_AUTHORIZED') {
    return '当前身份没有告警处置权限。';
  }
  if (code === 'ACCESS_MANAGE_NOT_AUTHORIZED') {
    return '只有超级管理员可以调整用户和群组角色。';
  }
  if (code === 'CONFIG_MANAGE_NOT_AUTHORIZED') {
    return '只有超级管理员可以修改、发布或回滚平台配置。';
  }
  if (code === 'CONFIG_DRAFT_IMMUTABLE') {
    return '该配置版本已经发布，不能再修改。';
  }
  if (code === 'CONFIG_VALIDATION_REQUIRED') {
    return '配置尚未通过服务端校验，不能发布。';
  }
  if (code === 'CONFIG_ROLLBACK_SOURCE_INVALID' || code === 'CONFIG_ROLLBACK_NO_CHANGE') {
    return fallback ?? '所选配置版本不能用于回滚。';
  }
  if (code === 'FEISHU_SUPER_ADMIN_REQUIRED') {
    return '当前飞书用户不是平台超级管理员，请使用普通成员入口。';
  }
  if (code === 'BOOTSTRAP_ROLE_BINDING_PROTECTED') {
    return '启动超级管理员绑定受保护，请通过部署配置变更。';
  }
  if (code === 'local_admin_session_unavailable') {
    return '本机管理员会话未启用，请使用飞书登录。';
  }
  if (code === 'FEISHU_OAUTH_DISABLED') {
    return '飞书登录尚未启用，请联系平台管理员。';
  }
  if (code === 'ADMIN_SESSION_REQUIRED') {
    return '管理会话不存在或已经过期，请重新使用飞书登录。';
  }
  if (status === 401 || status === 403) {
    return '管理会话已失效或权限不足，请重新验证身份。';
  }
  if (status >= 500) return '管理服务暂时不可用，请稍后重试。';
  return fallback ?? `管理接口返回 HTTP ${status}（${code}）。`;
}
