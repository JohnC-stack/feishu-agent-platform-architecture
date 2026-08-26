import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  AdminApiError,
  acknowledgeAlert,
  beginFeishuLogin,
  createConfigDraft,
  deleteRoleBinding,
  fetchAdminAuthConfig,
  fetchAdminSnapshot,
  fetchTaskTrace,
  logoutAdminSession,
  publishConfigDraft,
  rollbackConfigVersion,
  restoreAdminSession,
  submitAdminAction,
  upsertRoleBinding,
  updateConfigDraft,
  validateManagedConfig,
  type AdminAuthConfig,
  type AdminPageId,
  type AdminIdentity,
  type AdminOperation,
  type AdminSnapshot,
  type AlertRecord,
  type ConfigValidation,
  type ConfigVersion,
  type ManagedConfiguration,
  type RoleBindingInput,
  type TaskTrace,
} from './admin-api.js';

type PageId = AdminPageId;

const pages: Array<{ id: PageId; label: string; icon: string; group: string }> = [
  { id: 'overview', label: '管理驾驶舱', icon: '⌂', group: '总览' },
  { id: 'tasks', label: '任务与会话', icon: '任', group: '运行管理' },
  { id: 'runtime', label: '队列与节点', icon: '队', group: '运行管理' },
  { id: 'executors', label: '执行器与沙箱', icon: '执', group: '运行管理' },
  { id: 'trace', label: '日志与 Trace', icon: '迹', group: '运行管理' },
  { id: 'approvals', label: '审批中心', icon: '审', group: '安全治理' },
  { id: 'access', label: '成员与权限', icon: '权', group: '安全治理' },
  { id: 'budgets', label: 'Token 与成本', icon: '额', group: '安全治理' },
  { id: 'alerts', label: '告警中心', icon: '警', group: '安全治理' },
  { id: 'integrations', label: '系统集成', icon: '接', group: '平台运维' },
  { id: 'config', label: '配置中心', icon: '配', group: '平台运维' },
  { id: 'delivery', label: '发布与备份', icon: '发', group: '平台运维' },
  { id: 'operations', label: '运维操作', icon: '运', group: '平台运维' },
  { id: 'guide', label: '操作说明书', icon: '?', group: '帮助' },
];

const pageDescriptions: Record<PageId, string> = {
  overview: '集中呈现待办、平台健康、运行指标和当前身份可以执行的管理动作。',
  tasks: '按任务查看来源会话、路由结果、执行状态、重试次数和关联 Trace。',
  runtime: '观察 BullMQ 队列深度、Worker 在线状态、失败恢复和 readiness 明细。',
  executors: '管理 Direct Tool、Agent CLI、API/ReAct 及其工作区和隔离策略。',
  integrations: '检查飞书、GitLab、Confluence 等企业系统的配置与资源白名单。',
  approvals: '查看高风险操作的申请、审批人、终态和飞书卡片同步情况。',
  access: '审阅角色、用户与群组绑定以及管理能力的最小权限分配。',
  budgets: '按用户、群组、任务和模型观察 Token 与成本预算消耗。',
  trace: '从飞书来源事件追踪到任务、执行器、工具事件、错误和审计记录。',
  alerts: '集中处置队列、服务、模型、任务与预算告警，并保留确认记录。',
  config: '管理非敏感运行参数的草稿、校验、发布、差异、审计和回滚；Secret 永不进入数据库。',
  delivery: '查看版本、备份、校验、恢复演练和配置版本的交付状态。',
  operations: '在精确确认和 RBAC 约束下发起取消、重试、清理、重启或回滚。',
  guide: '按角色说明页面权限、日常巡检、审批、运维和故障处理步骤。',
};

const actionMeta: Record<
  AdminOperation['action'],
  { label: string; targetType: string; risk: string; confirmation: string }
> = {
  cancel: { label: '取消任务', targetType: 'task', risk: '中', confirmation: '确认取消任务' },
  retry: { label: '重试任务', targetType: 'task', risk: '高', confirmation: '确认重试任务' },
  cleanup: {
    label: '清理资源',
    targetType: 'workspace',
    risk: '高',
    confirmation: '确认清理资源',
  },
  restart: {
    label: '重启服务',
    targetType: 'service',
    risk: '严重',
    confirmation: '确认重启服务',
  },
  rollback: {
    label: '回滚版本',
    targetType: 'release',
    risk: '严重',
    confirmation: '确认回滚版本',
  },
};

export function App() {
  const [page, setPage] = useState<PageId>(() => readPageFromHash());
  const [identity, setIdentity] = useState<AdminIdentity>(() => readIdentity());
  const [snapshot, setSnapshot] = useState<AdminSnapshot>();
  const [trace, setTrace] = useState<TaskTrace>();
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [identityOpen, setIdentityOpen] = useState(!hasIdentity(identity));
  const [authorizationError, setAuthorizationError] = useState(false);
  const [superAdminEntry, setSuperAdminEntry] = useState(() => isSuperAdminLoginHash());
  const [authConfig, setAuthConfig] = useState<AdminAuthConfig>({
    feishu: { enabled: false },
    localBootstrapEnabled: false,
    manualIdentityEnabled: false,
  });

  const connectFeishu = useCallback(
    async (mode: 'standard' | 'super_admin' = 'standard') => {
      setLoading(true);
      setError('');
      try {
        await logoutAdminSession(identity);
      } catch {
        // A stale session must not block a new Feishu authorization flow.
      }
      clearStoredIdentity();
      beginFeishuLogin(mode);
    },
    [identity],
  );

  const refresh = useCallback(async () => {
    if (!hasIdentity(identity)) return;
    setLoading(true);
    setError('');
    try {
      setSnapshot(await fetchAdminSnapshot(identity));
    } catch (reason: unknown) {
      const sessionInvalid =
        reason instanceof AdminApiError && (reason.status === 401 || reason.status === 403);
      if (sessionInvalid) {
        clearStoredIdentity();
        setIdentity(emptyIdentity());
        setSnapshot(undefined);
        setAuthorizationError(true);
        setIdentityOpen(true);
      }
      setError(adminErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async (): Promise<void> => {
      setLoading(true);
      const callback = consumeAuthCallbackResult();
      if (callback.message) {
        setError(callback.message);
        setAuthorizationError(callback.unauthorized);
      }
      try {
        const config = await fetchAdminAuthConfig();
        if (cancelled) return;
        setAuthConfig(config);
        if (hasIdentity(identity)) return;
        const restored = await restoreAdminSession();
        if (cancelled) return;
        if (!restored) {
          setIdentityOpen(true);
          return;
        }
        const restoredSnapshot = await fetchAdminSnapshot(restored);
        if (cancelled) return;
        setIdentity(restored);
        setSnapshot(restoredSnapshot);
        setAuthorizationError(false);
        setIdentityOpen(false);
      } catch (reason: unknown) {
        if (cancelled) return;
        setError(adminErrorMessage(reason));
        setIdentityOpen(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
    // Authentication bootstrap intentionally runs only once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const handleHashChange = (): void => {
      setPage(readPageFromHash());
      setSuperAdminEntry(isSuperAdminLoginHash());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigatePage = useCallback((next: PageId): void => {
    setPage(next);
    window.history.replaceState(null, '', `#${next}`);
  }, []);

  const openTrace = useCallback(
    async (taskId: string) => {
      setSelectedTaskId(taskId);
      navigatePage('trace');
      setError('');
      try {
        setTrace(await fetchTaskTrace(identity, taskId));
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : 'Trace 加载失败。');
      }
    },
    [identity, navigatePage],
  );

  const logout = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      await logoutAdminSession(identity);
    } catch (reason: unknown) {
      setError(adminErrorMessage(reason));
    } finally {
      clearStoredIdentity();
      const next = emptyIdentity();
      setIdentity(next);
      setSnapshot(undefined);
      setTrace(undefined);
      setAuthorizationError(false);
      setIdentityOpen(true);
      setLoading(false);
    }
  };

  if (!snapshot) {
    return (
      <LoginPage
        authConfig={authConfig}
        loading={loading}
        error={error}
        unauthorized={authorizationError}
        superAdmin={superAdminEntry}
        onLogin={(mode) => void connectFeishu(mode)}
      />
    );
  }

  const allowedPages = snapshot.viewer.capabilities.allowedPages;
  const visiblePage = allowedPages.includes(page) ? page : (allowedPages[0] ?? 'overview');

  const content = (
    <PageContent
      page={visiblePage}
      snapshot={snapshot}
      trace={trace}
      selectedTaskId={selectedTaskId}
      identity={identity}
      onOpenTrace={openTrace}
      onRefresh={refresh}
      onError={setError}
      onNavigate={navigatePage}
    />
  );

  const currentPage = pages.find((item) => item.id === visiblePage);
  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">FA</span>
          <span>
            <strong>AgentOps</strong>
            <small>飞书智能体管理中心</small>
          </span>
        </div>
        <div className="environmentPill">
          <span /> <strong>稳定</strong> · P7 LIVE
        </div>
        <nav aria-label="平台功能">
          {[
            ...new Set(
              pages.filter((item) => allowedPages.includes(item.id)).map((item) => item.group),
            ),
          ].map((group) => (
            <div className="navGroup" key={group}>
              <p>{group}</p>
              {pages
                .filter((item) => item.group === group && allowedPages.includes(item.id))
                .map((item) => (
                  <button
                    className={visiblePage === item.id ? 'navItem active' : 'navItem'}
                    key={item.id}
                    type="button"
                    onClick={() => navigatePage(item.id)}
                  >
                    <span className="navIcon">{item.icon}</span>
                    <span>{item.label}</span>
                    {item.id === 'alerts' && snapshot && snapshot.summary.openAlerts > 0 ? (
                      <small className="navCount">{snapshot.summary.openAlerts}</small>
                    ) : null}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebarFooter">
          <span className={snapshot ? 'statusDot' : 'statusDot offline'} />
          {snapshot ? 'Control API 已连接' : authorizationError ? '身份未授权' : '正在建立会话'}
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">{currentPage?.group} / P7</p>
            <h1>{currentPage?.label}</h1>
            <p className="pageDescription">{currentPage ? pageDescriptions[currentPage.id] : ''}</p>
          </div>
          <div className="topbarActions">
            {snapshot.viewer.capabilities.isSuperAdmin ? (
              <span className="superAdminChip">超级管理员</span>
            ) : (
              <span className="scopeChip">受限权限</span>
            )}
            <span className="updatedAt">
              {snapshot ? `更新 ${formatDateTime(snapshot.generatedAt)}` : '尚未加载'}
            </span>
            <button className="guideButton" type="button" onClick={() => navigatePage('guide')}>
              ? 操作说明
            </button>
            <button
              className="refreshButton"
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? '刷新中…' : '↻ 刷新'}
            </button>
            <button className="identityButton" type="button" onClick={() => setIdentityOpen(true)}>
              <span>
                {(identity.displayName || identity.actorId || '?').slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{identity.displayName || identity.actorId || '设置管理身份'}</strong>
                <small>{snapshot.viewer.roleIds.map(roleLabel).join(' · ') || 'RBAC 验证'}</small>
              </div>
            </button>
          </div>
        </header>

        {error ? (
          <div className="errorBanner">
            <span>!</span>
            {error}
            <button type="button" onClick={() => setError('')}>
              ×
            </button>
          </div>
        ) : null}
        {content}
      </main>

      {identityOpen ? (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="identity-title"
          >
            <div className="modalHeader">
              <div>
                <p className="eyebrow">GOVERNED ACCESS</p>
                <h2 id="identity-title">管理身份</h2>
              </div>
              {hasIdentity(identity) ? (
                <button type="button" onClick={() => setIdentityOpen(false)}>
                  ×
                </button>
              ) : null}
            </div>
            <p className="modalIntro">
              当前会话仅通过飞书企业身份建立，页面和操作由 RBAC 实时授权。
            </p>
            <div className="accountSummary">
              <span>{(identity.displayName || '?').slice(0, 1)}</span>
              <div>
                <strong>{identity.displayName || '飞书用户'}</strong>
                <small>{snapshot.viewer.roleIds.map(roleLabel).join(' · ')}</small>
              </div>
            </div>
            <div className="safeNotice">
              <span>✓</span>
              <div>
                <strong>服务端安全会话</strong>
                <small>
                  授权码、飞书 Token 和 App Secret 不进入浏览器存储，登录态使用 HttpOnly Cookie。
                </small>
              </div>
            </div>
            <button className="textButton full" type="button" onClick={() => void logout()}>
              退出当前飞书会话
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PageContent(props: {
  page: PageId;
  snapshot: AdminSnapshot;
  trace?: TaskTrace;
  selectedTaskId: string;
  identity: AdminIdentity;
  onOpenTrace: (taskId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onNavigate: (page: PageId) => void;
}) {
  switch (props.page) {
    case 'overview':
      return (
        <Overview
          snapshot={props.snapshot}
          onOpenTrace={props.onOpenTrace}
          onNavigate={props.onNavigate}
        />
      );
    case 'tasks':
      return <TasksPage snapshot={props.snapshot} onOpenTrace={props.onOpenTrace} />;
    case 'runtime':
      return <RuntimePage snapshot={props.snapshot} />;
    case 'executors':
      return <ExecutorsPage snapshot={props.snapshot} />;
    case 'integrations':
      return <IntegrationsPage snapshot={props.snapshot} />;
    case 'approvals':
      return <ApprovalsPage snapshot={props.snapshot} />;
    case 'access':
      return (
        <AccessPage
          snapshot={props.snapshot}
          identity={props.identity}
          onRefresh={props.onRefresh}
          onError={props.onError}
        />
      );
    case 'budgets':
      return <BudgetsPage snapshot={props.snapshot} />;
    case 'trace':
      return (
        <TracePage
          snapshot={props.snapshot}
          trace={props.trace}
          selectedTaskId={props.selectedTaskId}
          onOpenTrace={props.onOpenTrace}
        />
      );
    case 'alerts':
      return <AlertsPage {...props} />;
    case 'config':
      return (
        <ConfigPage
          key={configEditorSourceId(props.snapshot)}
          snapshot={props.snapshot}
          identity={props.identity}
          onRefresh={props.onRefresh}
          onError={props.onError}
        />
      );
    case 'delivery':
      return <DeliveryPage snapshot={props.snapshot} />;
    case 'operations':
      return <OperationsPage {...props} />;
    case 'guide':
      return <GuidePage snapshot={props.snapshot} onNavigate={props.onNavigate} />;
  }
}

function Overview({
  snapshot,
  onOpenTrace,
  onNavigate,
}: {
  snapshot: AdminSnapshot;
  onOpenTrace: (taskId: string) => Promise<void>;
  onNavigate: (page: PageId) => void;
}) {
  const success = snapshot.data.taskCounts.succeeded ?? 0;
  const successRate = Math.round((success / Math.max(snapshot.summary.totalTasks, 1)) * 100);
  const allowed = new Set(snapshot.viewer.capabilities.allowedPages);
  const quickActions: Array<{ page: PageId; label: string; detail: string; tone: string }> = [
    ...(allowed.has('approvals')
      ? [
          {
            page: 'approvals' as const,
            label: '处理审批',
            detail: `${snapshot.summary.pendingApprovals} 项待处理`,
            tone: 'amber',
          },
        ]
      : []),
    ...(allowed.has('access')
      ? [
          {
            page: 'access' as const,
            label: '分配成员权限',
            detail: '新增或移除角色绑定',
            tone: 'blue',
          },
        ]
      : []),
    ...(allowed.has('alerts')
      ? [
          {
            page: 'alerts' as const,
            label: '处置告警',
            detail: `${snapshot.summary.openAlerts} 项开放`,
            tone: 'red',
          },
        ]
      : []),
    ...(allowed.has('operations')
      ? [
          {
            page: 'operations' as const,
            label: '发起运维操作',
            detail: '取消、重试、重启或回滚',
            tone: 'purple',
          },
        ]
      : []),
    ...(allowed.has('integrations')
      ? [
          {
            page: 'integrations' as const,
            label: '检查系统集成',
            detail: '飞书、GitLab、Confluence',
            tone: 'green',
          },
        ]
      : []),
    { page: 'guide', label: '查看操作说明', detail: '按角色了解日常工作流程', tone: 'slate' },
  ];
  return (
    <div className="overviewStack">
      <section className="heroPanel">
        <div>
          <span className="heroLabel">
            {snapshot.viewer.capabilities.isSuperAdmin ? '超级管理员控制台' : '我的管理工作台'}
          </span>
          <h2>
            {snapshot.summary.criticalAlerts > 0
              ? '存在需要立即处理的严重告警'
              : '平台运行稳定，管理链路持续受控'}
          </h2>
          <p>
            当前角色：{snapshot.viewer.roleIds.map(roleLabel).join('、')}
            。这里仅展示你有权查看和执行的管理事项。
          </p>
        </div>
        <div className={`healthScore ${snapshot.summary.criticalAlerts > 0 ? 'danger' : ''}`}>
          <strong>{snapshot.summary.criticalAlerts > 0 ? '需处理' : '稳定'}</strong>
          <span>P7 LIVE</span>
        </div>
      </section>
      <section className="metricGrid">
        <Metric
          label="任务总量"
          value={snapshot.summary.totalTasks}
          detail={`成功率 ${successRate}%`}
          tone="blue"
        />
        <Metric
          label="活动任务"
          value={snapshot.summary.activeTasks}
          detail={`队列等待 ${snapshot.queue.waiting}`}
          tone="purple"
        />
        <Metric
          label="待审批"
          value={snapshot.summary.pendingApprovals}
          detail="高风险写操作"
          tone="amber"
        />
        <Metric
          label="开放告警"
          value={snapshot.summary.openAlerts}
          detail={`严重 ${snapshot.summary.criticalAlerts}`}
          tone={snapshot.summary.criticalAlerts > 0 ? 'red' : 'green'}
        />
        <Metric
          label="Token 使用"
          value={compactNumber(snapshot.summary.tokensUsed)}
          detail={formatCost(snapshot.summary.costMicrosUsed)}
          tone="cyan"
        />
      </section>
      <section className="commandSection">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">MANAGEMENT ACTIONS</p>
            <h2>快捷管理</h2>
          </div>
          <span>根据当前 RBAC 动态开放</span>
        </div>
        <div className="commandGrid">
          {quickActions.map((action) => (
            <button
              key={action.page}
              className={`commandCard ${action.tone}`}
              type="button"
              onClick={() => onNavigate(action.page)}
            >
              <span>{pages.find((item) => item.id === action.page)?.icon ?? '→'}</span>
              <div>
                <strong>{action.label}</strong>
                <small>{action.detail}</small>
              </div>
              <b>→</b>
            </button>
          ))}
        </div>
      </section>
      <div className="dashboardGrid">
        <Panel
          title="服务健康"
          eyebrow="RUNTIME HEALTH"
          action={`${snapshot.services.filter((item) => item.status === 'ok').length}/${snapshot.services.length} 正常`}
        >
          <div className="serviceGrid">
            {snapshot.services.map((service) => (
              <ServiceCard key={service.service} service={service} />
            ))}
          </div>
        </Panel>
        <Panel title="队列吞吐" eyebrow="BULLMQ" action="实时快照">
          <QueueBars queue={snapshot.queue} />
        </Panel>
        {allowed.has('tasks') ? (
          <Panel
            title="最近任务"
            eyebrow="TASK STREAM"
            action={`${snapshot.data.tasks.length} 条`}
            wide
          >
            <TaskTable tasks={snapshot.data.tasks.slice(0, 8)} onOpenTrace={onOpenTrace} />
          </Panel>
        ) : null}
        <Panel title="当前告警" eyebrow="ALERTS" action={`${snapshot.summary.openAlerts} 开放`}>
          <AlertList
            alerts={snapshot.data.alerts.filter((item) => item.status !== 'resolved').slice(0, 5)}
          />
        </Panel>
      </div>
    </div>
  );
}

function TasksPage({
  snapshot,
  onOpenTrace,
}: {
  snapshot: AdminSnapshot;
  onOpenTrace: (taskId: string) => Promise<void>;
}) {
  return (
    <div className="stack">
      <section className="statusStrip">
        {Object.entries(snapshot.data.taskCounts).map(([status, count]) => (
          <div key={status}>
            <span className={`statusDotInline ${toneForStatus(status)}`} />
            <strong>{statusLabel(status)}</strong>
            <b>{count}</b>
          </div>
        ))}
      </section>
      <Panel title="任务中心" eyebrow="TASKS" action={`${snapshot.data.tasks.length} 条`}>
        <TaskTable tasks={snapshot.data.tasks} onOpenTrace={onOpenTrace} />
      </Panel>
      <Panel
        title="会话中心"
        eyebrow="CONVERSATIONS"
        action={`${snapshot.data.conversations.length} 个会话`}
      >
        <DataTable
          columns={['会话', '用户', '消息', '摘要版本', '最后活动']}
          rows={snapshot.data.conversations.map((item) => [
            shortId(item.id),
            shortId(item.userId),
            value(item.messageCount),
            value(item.summaryVersion),
            formatDateTime(item.updatedAt),
          ])}
        />
      </Panel>
    </div>
  );
}

function RuntimePage({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <div className="dashboardGrid">
      <Panel title="队列深度" eyebrow="QUEUE DEPTH" action="BullMQ" wide>
        <QueueBars queue={snapshot.queue} />
      </Panel>
      <Panel title="服务实例" eyebrow="WORKERS" action={`${snapshot.services.length} 个`} wide>
        <div className="serviceGrid large">
          {snapshot.services.map((service) => (
            <ServiceCard key={service.service} service={service} />
          ))}
        </div>
      </Panel>
      <Panel title="恢复与失败" eyebrow="RELIABILITY" action="实时">
        <div className="statRows">
          <StatRow label="延迟任务" value={snapshot.queue.delayed} />
          <StatRow label="失败作业" value={snapshot.queue.failed} tone="red" />
          <StatRow label="死信任务" value={snapshot.queue.deadLettered} tone="amber" />
          <StatRow label="累计完成" value={snapshot.queue.completed} tone="green" />
        </div>
      </Panel>
      <Panel title="健康检查明细" eyebrow="READINESS" action="2.5s 超时">
        <div className="checkList">
          {snapshot.services.flatMap((service) =>
            service.checks.map((check) => (
              <div key={`${service.service}-${check.name}`}>
                <span className={check.ok ? 'okDot' : 'badDot'} />
                <strong>
                  {service.service} / {check.name}
                </strong>
                <small>{check.detail || (check.ok ? '正常' : '失败')}</small>
              </div>
            )),
          )}
        </div>
      </Panel>
    </div>
  );
}

function ExecutorsPage({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <div className="stack">
      <section className="executorCards">
        <ExecutorCard
          name="Direct Tool"
          state="启用"
          detail="确定性 API/CLI · 零模型 Token"
          tone="green"
        />
        <ExecutorCard
          name="Agent CLI"
          state="启用"
          detail="代码、本地文件和复杂任务"
          tone="purple"
        />
        <ExecutorCard
          name="API / ReAct"
          state="已关闭"
          detail="不参与路由、就绪和回退"
          tone="muted"
        />
      </section>
      <Panel
        title="执行器运行记录"
        eyebrow="EXECUTOR RUNS"
        action={`${snapshot.data.executorRuns.length} 条`}
      >
        <DataTable
          columns={['运行 ID', '任务', '执行器', '状态', '尝试', '开始', '错误']}
          rows={snapshot.data.executorRuns.map((item) => [
            shortId(item.id),
            shortId(item.taskId),
            value(item.executor || item.requestedExecutor),
            <Status value={value(item.status)} />,
            value(item.attempt),
            formatDateTime(item.startedAt),
            value(item.errorCode, '—'),
          ])}
        />
      </Panel>
    </div>
  );
}

function IntegrationsPage({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <div className="integrationGrid">
      {snapshot.integrations.map((item) => (
        <article className="integrationCard" key={item.id}>
          <div className={`integrationLogo ${item.id}`}>{item.name.slice(0, 1)}</div>
          <div className="integrationHeader">
            <div>
              <h3>{item.name}</h3>
              <small>{item.mode}</small>
            </div>
            <Status value={item.status} />
          </div>
          <p>{item.detail}</p>
          <div className="integrationMeta">
            <div>
              <span>授权资源</span>
              <strong>{item.resourceCount ?? '—'}</strong>
            </div>
            <div>
              <span>状态来源</span>
              <strong>{integrationSourceLabel(item.source)}</strong>
            </div>
            {item.checkedAt ? (
              <div>
                <span>检查时间</span>
                <strong>{formatDateTime(item.checkedAt)}</strong>
              </div>
            ) : null}
          </div>
          <div className="integrationFooter">
            <span
              className={
                item.status === 'ready' || item.status === 'configured'
                  ? 'okDot'
                  : item.status === 'disabled'
                    ? 'neutralDot'
                    : 'warnDot'
              }
            />
            {item.status === 'ready' || item.status === 'configured'
              ? '配置完整'
              : item.status === 'disabled'
                ? '按策略关闭'
                : item.status === 'offline'
                  ? '状态端点不可用'
                  : '等待配置'}
          </div>
        </article>
      ))}
    </div>
  );
}

function ApprovalsPage({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <div className="stack">
      <section className="metricGrid compact">
        <Metric
          label="待审批"
          value={snapshot.data.approvals.filter((item) => item.status === 'pending').length}
          detail="需要人工决策"
          tone="amber"
        />
        <Metric
          label="已批准"
          value={snapshot.data.approvals.filter((item) => item.status === 'approved').length}
          detail="职责分离"
          tone="green"
        />
        <Metric
          label="已拒绝"
          value={snapshot.data.approvals.filter((item) => item.status === 'rejected').length}
          detail="终态"
          tone="red"
        />
      </section>
      <Panel title="审批记录" eyebrow="APPROVAL GOVERNANCE" action="WSS 卡片同步">
        <DataTable
          columns={['审批 ID', '工具 / 资源', '风险', '申请人', '审批人', '状态', '创建时间']}
          rows={snapshot.data.approvals.map((item) => [
            shortId(item.id),
            `${value(item.toolName, '平台操作')} · ${value(item.resourceType, '—')}`,
            <Risk value={value(item.riskLevel, '—')} />,
            shortId(item.requestedBy),
            shortId(item.decidedBy),
            <Status value={value(item.status)} />,
            formatDateTime(item.createdAt),
          ])}
        />
      </Panel>
    </div>
  );
}

function AccessPage({
  snapshot,
  identity,
  onRefresh,
  onError,
}: {
  snapshot: AdminSnapshot;
  identity: AdminIdentity;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<RoleBindingInput>({
    principalType: 'user',
    principalId: '',
    roleId: 'reader',
  });
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const save = async (): Promise<void> => {
    setWorking(true);
    setNotice('');
    try {
      await upsertRoleBinding(identity, { ...draft, principalId: draft.principalId.trim() });
      setDraft({ ...draft, principalId: '' });
      setNotice('角色绑定已保存并立即生效。');
      await onRefresh();
    } catch (reason: unknown) {
      onError(adminErrorMessage(reason));
    } finally {
      setWorking(false);
    }
  };
  const remove = async (binding: RoleBindingInput): Promise<void> => {
    const roleName = roleLabel(binding.roleId);
    const subjectName = binding.principalType === 'user' ? '用户' : '群组';
    if (!window.confirm(`确定移除${subjectName} ${binding.principalId} 的“${roleName}”角色吗？`)) {
      return;
    }
    setWorking(true);
    setNotice('');
    try {
      await deleteRoleBinding(identity, binding);
      setNotice('角色绑定已移除。');
      await onRefresh();
    } catch (reason: unknown) {
      onError(adminErrorMessage(reason));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="accessLayout">
      <section className="accessIntro">
        <div>
          <p className="eyebrow">IDENTITY & ACCESS MANAGEMENT</p>
          <h2>成员权限管理</h2>
        </div>
        <p>
          所有成员都通过飞书登录。超级管理员在这里把用户或飞书群组绑定到最小必要角色，变更即时生效并写入审计。
        </p>
      </section>
      <div className="twoColumn accessColumns">
        <Panel title="系统角色" eyebrow="RBAC ROLES" action={`${snapshot.data.roles.length} 个`}>
          <div className="roleList">
            {snapshot.data.roles.map((item) => (
              <article key={value(item.id)}>
                <span className="roleAvatar">{value(item.name).slice(0, 1)}</span>
                <div>
                  <strong>{value(item.name)}</strong>
                  <small>{value(item.description, '—')}</small>
                </div>
                <b>
                  {value(item.id) === 'administrator'
                    ? '全部权限'
                    : `${Array.isArray(item.permissions) ? item.permissions.length : 0} 项权限`}
                </b>
              </article>
            ))}
          </div>
        </Panel>
        <Panel title="新增角色绑定" eyebrow="ASSIGN ROLE" action="立即生效">
          <div className="roleBindingForm">
            <label>
              主体类型
              <select
                value={draft.principalType}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    principalType: event.target.value as RoleBindingInput['principalType'],
                  })
                }
              >
                <option value="user">飞书用户</option>
                <option value="group">飞书群组</option>
              </select>
            </label>
            <label>
              {draft.principalType === 'user' ? '用户 Open ID' : '群组 ID'}
              <input
                value={draft.principalId}
                onChange={(event) => setDraft({ ...draft, principalId: event.target.value })}
                placeholder={draft.principalType === 'user' ? 'ou_xxx' : 'oc_xxx'}
              />
            </label>
            <label>
              角色
              <select
                value={draft.roleId}
                onChange={(event) =>
                  setDraft({ ...draft, roleId: event.target.value as RoleBindingInput['roleId'] })
                }
              >
                <option value="reader">只读成员</option>
                <option value="operator">运行操作员</option>
                <option value="approver">审批员</option>
                <option value="auditor">审计员</option>
                <option value="administrator">超级管理员</option>
              </select>
            </label>
            <div className="roleFormHint">
              <strong>安全提示</strong>
              <span>超级管理员拥有全部能力；日常账号建议使用 operator、approver 或 auditor。</span>
            </div>
            {notice ? <div className="successNotice">✓ {notice}</div> : null}
            <button
              className="primaryButton"
              type="button"
              disabled={working || draft.principalId.trim().length < 3}
              onClick={() => void save()}
            >
              {working ? '正在保存…' : '保存角色绑定'}
            </button>
          </div>
        </Panel>
      </div>
      <Panel
        title="当前成员与群组"
        eyebrow="ROLE BINDINGS"
        action={`${snapshot.data.roleBindings.length} 条`}
      >
        <DataTable
          columns={['主体', '飞书标识', '角色', '来源', '操作']}
          rows={snapshot.data.roleBindings.map((item) => [
            value(item.principalType) === 'user' ? '用户' : '群组',
            <code title={value(item.principalId)}>{shortId(item.principalId)}</code>,
            roleLabel(value(item.roleId)),
            value(item.managedBy) === 'bootstrap' ? <Status value="protected" /> : '管理中心',
            <button
              className="tableDangerButton"
              type="button"
              disabled={working || value(item.managedBy) === 'bootstrap'}
              title={value(item.managedBy) === 'bootstrap' ? '启动绑定受保护' : '移除角色'}
              onClick={() =>
                void remove({
                  principalType: value(item.principalType) as RoleBindingInput['principalType'],
                  principalId: value(item.principalId),
                  roleId: value(item.roleId) as RoleBindingInput['roleId'],
                })
              }
            >
              移除
            </button>,
          ])}
        />
      </Panel>
    </div>
  );
}

function BudgetsPage({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <div className="stack">
      <section className="metricGrid compact">
        <Metric
          label="累计 Token"
          value={compactNumber(snapshot.summary.tokensUsed)}
          detail="全部预算窗口"
          tone="cyan"
        />
        <Metric
          label="累计成本"
          value={formatCost(snapshot.summary.costMicrosUsed)}
          detail="估算值"
          tone="purple"
        />
        <Metric
          label="预算告警"
          value={
            snapshot.data.alerts.filter(
              (item) => item.category === 'budget' && item.status !== 'resolved',
            ).length
          }
          detail="阈值 80%"
          tone="amber"
        />
      </section>
      <Panel title="预算使用" eyebrow="TOKEN & COST" action="用户 · 群组 · 任务 · 模型">
        <div className="budgetList">
          {snapshot.data.budgets.map((item, index) => {
            const limit = Number(item.tokenLimit ?? 0);
            const used = Number(item.tokensUsed ?? 0);
            const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
            return (
              <article key={`${value(item.scopeType)}-${value(item.scopeId)}-${index}`}>
                <div>
                  <strong>
                    {value(item.scopeType)} / {shortId(item.scopeId)}
                  </strong>
                  <small>
                    {value(item.period)} · {compactNumber(used)} / {compactNumber(limit)} Token
                  </small>
                </div>
                <div className="budgetBar">
                  <span
                    style={{ width: `${percent}%` }}
                    className={percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : ''}
                  />
                </div>
                <b>{percent}%</b>
              </article>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function TracePage({
  snapshot,
  trace,
  selectedTaskId,
  onOpenTrace,
}: {
  snapshot: AdminSnapshot;
  trace?: TaskTrace;
  selectedTaskId: string;
  onOpenTrace: (taskId: string) => Promise<void>;
}) {
  const events = trace
    ? [...trace.taskEvents, ...trace.executorEvents].sort((left, right) =>
        value(left.createdAt).localeCompare(value(right.createdAt)),
      )
    : [];
  return (
    <div className="traceLayout">
      <aside className="traceTasks">
        <p className="eyebrow">TASK INDEX</p>
        <h3>选择任务</h3>
        {snapshot.data.tasks.map((item) => (
          <button
            type="button"
            className={selectedTaskId === value(item.id) ? 'selected' : ''}
            key={value(item.id)}
            onClick={() => void onOpenTrace(value(item.id))}
          >
            <span className={`statusDotInline ${toneForStatus(value(item.status))}`} />
            <div>
              <strong>{shortId(item.id)}</strong>
              <small>{value(item.inputSummary, '无摘要')}</small>
            </div>
          </button>
        ))}
      </aside>
      <section className="traceContent">
        {trace ? (
          <>
            <div className="traceHeader">
              <div>
                <p className="eyebrow">CORRELATION TRACE</p>
                <h2>
                  {shortId(trace.task.id)} · {statusLabel(value(trace.task.status))}
                </h2>
                <small>{value(trace.task.correlationId)}</small>
              </div>
              <Status value={value(trace.task.status)} />
            </div>
            <div className="traceFlow">
              <TraceNode label="飞书事件" detail={shortId(trace.task.sourceEventId)} state="done" />
              <TraceNode
                label="任务路由"
                detail={value(trace.task.executor, '待分配')}
                state="done"
              />
              <TraceNode
                label="执行器"
                detail={`${trace.executorRuns.length} 次运行`}
                state={
                  trace.executorRuns.some((item) => item.status === 'failed') ? 'failed' : 'done'
                }
              />
              <TraceNode
                label="工具与结果"
                detail={`${trace.executorEvents.length} 个事件`}
                state={value(trace.task.status) === 'failed' ? 'failed' : 'done'}
              />
            </div>
            <Panel title="时间线" eyebrow="EVENTS" action={`${events.length} 个事件`}>
              <div className="eventTimeline">
                {events.map((event, index) => (
                  <article key={`${value(event.createdAt)}-${index}`}>
                    <span className={value(event.kind) === 'failed' ? 'badDot' : 'okDot'} />
                    <div>
                      <strong>{statusLabel(value(event.kind))}</strong>
                      <small>{value(event.message, '无消息')}</small>
                    </div>
                    <time>{formatDateTime(event.createdAt)}</time>
                  </article>
                ))}
              </div>
            </Panel>
            <Panel title="关联审计" eyebrow="AUDIT" action={`${trace.auditEvents.length} 条`}>
              <DataTable
                columns={['时间', '操作人', '动作', '资源', '结果']}
                rows={trace.auditEvents.map((item) => [
                  formatDateTime(item.createdAt),
                  shortId(item.actorId),
                  value(item.action),
                  `${value(item.resourceType)}/${shortId(item.resourceId)}`,
                  <Status value={value(item.outcome)} />,
                ])}
              />
            </Panel>
          </>
        ) : (
          <div className="emptyState">
            <span>⌁</span>
            <h2>选择任务查看完整链路</h2>
            <p>从飞书事件追踪到任务、执行器、工具、错误和审计。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function AlertsPage(props: {
  snapshot: AdminSnapshot;
  identity: AdminIdentity;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const handleAck = async (alert: AlertRecord) => {
    setBusy(alert.id);
    try {
      await acknowledgeAlert(props.identity, alert.id);
      await props.onRefresh();
    } catch (reason: unknown) {
      props.onError(reason instanceof Error ? reason.message : '确认告警失败。');
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="stack">
      <section className="metricGrid compact">
        <Metric
          label="严重"
          value={
            props.snapshot.data.alerts.filter(
              (item) => item.severity === 'critical' && item.status !== 'resolved',
            ).length
          }
          detail="需要立即处理"
          tone="red"
        />
        <Metric
          label="警告"
          value={
            props.snapshot.data.alerts.filter(
              (item) => item.severity === 'warning' && item.status !== 'resolved',
            ).length
          }
          detail="需要关注"
          tone="amber"
        />
        <Metric
          label="已确认"
          value={props.snapshot.data.alerts.filter((item) => item.status === 'acknowledged').length}
          detail="处理中"
          tone="blue"
        />
      </section>
      <div className="alertCards">
        {props.snapshot.data.alerts.map((alert) => (
          <article className={`alertCard ${alert.severity}`} key={alert.id}>
            <div className="alertSeverity">
              {alert.severity === 'critical' ? '!!' : alert.severity === 'warning' ? '!' : 'i'}
            </div>
            <div className="alertBody">
              <div>
                <Risk value={alert.severity} />
                <small>
                  {alert.source} · {formatDateTime(alert.lastSeenAt)}
                </small>
              </div>
              <h3>{alert.title}</h3>
              <p>{alert.message}</p>
              <span>{statusLabel(alert.status)}</span>
            </div>
            {alert.status === 'open' ? (
              <button
                type="button"
                disabled={busy === alert.id}
                onClick={() => void handleAck(alert)}
              >
                {busy === alert.id ? '处理中…' : '确认告警'}
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function ConfigPage(props: {
  snapshot: AdminSnapshot;
  identity: AdminIdentity;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { snapshot } = props;
  const versions = snapshot.data.configVersions;
  const draft = versions.find((item) => item.status === 'draft');
  const active = versions.find((item) => item.status === 'active');
  const source = draft ?? active;
  const [configuration, setConfiguration] = useState<ManagedConfiguration>(() =>
    managedEditorValues(snapshot, source),
  );
  const [description, setDescription] = useState(source?.description ?? '平台运行参数');
  const [changeSummary, setChangeSummary] = useState(source?.changeSummary ?? '初始化配置中心');
  const [validation, setValidation] = useState<ConfigValidation>();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState('');
  const [comparisonId, setComparisonId] = useState(active?.id ?? source?.id ?? '');
  const [rollbackTarget, setRollbackTarget] = useState<ConfigVersion>();
  const [rollbackConfirmation, setRollbackConfirmation] = useState('');
  const [rollbackSummary, setRollbackSummary] = useState('恢复经过验证的历史配置');

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    props.onError('');
    try {
      await action();
    } catch (reason: unknown) {
      props.onError(adminErrorMessage(reason));
    } finally {
      setBusy('');
    }
  };

  const validate = () =>
    run('validate', async () => {
      const result = await validateManagedConfig(props.identity, configuration);
      setConfiguration(result.configuration);
      setValidation(result);
    });

  const save = () =>
    run('save', async () => {
      const input = { configuration, description, changeSummary };
      if (draft) {
        await updateConfigDraft(props.identity, draft.id, input);
      } else {
        await createConfigDraft(props.identity, {
          ...input,
          ...(active ? { baseVersion: active.version } : {}),
        });
      }
      await props.onRefresh();
    });

  const publish = () => {
    if (!draft) return Promise.resolve();
    return run('publish', async () => {
      await publishConfigDraft(props.identity, draft.id, confirmation);
      await props.onRefresh();
    });
  };

  const rollback = () => {
    if (!rollbackTarget) return Promise.resolve();
    return run('rollback', async () => {
      await rollbackConfigVersion(props.identity, rollbackTarget.id, {
        confirmation: rollbackConfirmation,
        changeSummary: rollbackSummary,
      });
      setRollbackTarget(undefined);
      setRollbackConfirmation('');
      await props.onRefresh();
    });
  };

  const compared = versions.find((item) => item.id === comparisonId);
  const changes = configDifferences(active, compared, snapshot.managedConfiguration.catalog);
  const groups = [...new Set(snapshot.configuration.map((item) => item.group))];
  return (
    <div className="stack">
      <div className="securityBanner">
        <span>◆</span>
        <div>
          <strong>安全边界已启用</strong>
          <p>
            数据库只接收允许列表中的非敏感整数参数。Secret、Token、密码、连接串、TLS
            私钥和凭据内容始终保留在受保护启动配置中。
          </p>
        </div>
      </div>

      <section className="configWorkspace">
        <div className="configEditor">
          <div className="sectionHeading">
            <div>
              <p className="eyebrow">MANAGED CONFIGURATION</p>
              <h2>运行参数编辑器</h2>
            </div>
            <span>
              {draft
                ? `草稿 v${draft.version}`
                : active
                  ? `当前生效 v${active.version}`
                  : '尚无数据库版本'}
            </span>
          </div>
          <div className="managedFieldGrid">
            {snapshot.managedConfiguration.catalog.map((item) => (
              <label key={item.key}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <div>
                  <input
                    type="number"
                    min={item.minimum}
                    max={item.maximum}
                    value={configuration[item.key] ?? item.defaultValue}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        [item.key]: Number(event.target.value),
                      }))
                    }
                  />
                  <b>{item.unit}</b>
                </div>
                <code>{item.key}</code>
              </label>
            ))}
          </div>
          <div className="configMetaFields">
            <label>
              <span>版本说明</span>
              <input
                value={description}
                maxLength={1_000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="说明这组配置的用途"
              />
            </label>
            <label>
              <span>变更摘要</span>
              <textarea
                value={changeSummary}
                maxLength={2_000}
                onChange={(event) => setChangeSummary(event.target.value)}
                placeholder="说明本次调整原因和影响"
              />
            </label>
          </div>
          {validation ? (
            <div className={`configValidation ${validation.valid ? 'valid' : 'invalid'}`}>
              <strong>{validation.valid ? '✓ 服务端校验通过' : '! 服务端校验未通过'}</strong>
              {[...validation.errors, ...validation.warnings].map((message) => (
                <span key={message}>{message}</span>
              ))}
            </div>
          ) : null}
          <div className="configActions">
            <button type="button" disabled={Boolean(busy)} onClick={() => void validate()}>
              {busy === 'validate' ? '校验中…' : '校验配置'}
            </button>
            <button
              className="primaryAction"
              type="button"
              disabled={Boolean(busy) || !description.trim() || !changeSummary.trim()}
              onClick={() => void save()}
            >
              {busy === 'save' ? '保存中…' : draft ? '更新草稿' : '创建草稿'}
            </button>
          </div>
        </div>

        <aside className="publishRail">
          <p className="eyebrow">PUBLISH GATE</p>
          <h3>校验与发布</h3>
          <ol>
            <li className={validation?.valid ? 'done' : ''}>服务端类型及允许列表校验</li>
            <li className={draft?.validation.valid ? 'done' : ''}>草稿校验结果入库</li>
            <li className={active ? 'done' : ''}>发布为唯一生效版本</li>
          </ol>
          {draft ? (
            <div className="confirmationBox">
              <span>输入精确确认文本</span>
              <code>{`发布配置版本:${draft.version}`}</code>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="粘贴上方确认文本"
              />
              <button
                type="button"
                disabled={Boolean(busy) || confirmation !== `发布配置版本:${draft.version}`}
                onClick={() => void publish()}
              >
                {busy === 'publish' ? '发布中…' : '发布并即时生效'}
              </button>
            </div>
          ) : (
            <p className="railEmpty">先创建并保存草稿，发布入口才会开放。</p>
          )}
          <small>发布后告警阈值与探测超时在下一次管理快照中生效，无需重启。</small>
        </aside>
      </section>

      <Panel title="配置版本与差异" eyebrow="VERSION HISTORY" action={`${versions.length} 个版本`}>
        <div className="versionToolbar">
          <label>
            对比当前生效版本与
            <select value={comparisonId} onChange={(event) => setComparisonId(event.target.value)}>
              <option value="">选择版本</option>
              {versions.map((item) => (
                <option key={item.id} value={item.id}>
                  v{item.version} · {statusLabel(item.status)}
                </option>
              ))}
            </select>
          </label>
          <span>{changes.length} 项差异</span>
        </div>
        {changes.length > 0 ? (
          <div className="configDiffList">
            {changes.map((item) => (
              <article key={item.key}>
                <div>
                  <strong>{item.label}</strong>
                  <code>{item.key}</code>
                </div>
                <span>{item.before}</span>
                <b>→</b>
                <span>{item.after}</span>
              </article>
            ))}
          </div>
        ) : null}
        <DataTable
          columns={['版本', '说明', '校验和', '状态', '创建/启用', '操作']}
          rows={versions.map((item) => [
            <strong key={`version-${item.id}`}>v{item.version}</strong>,
            <span className="summaryCell" key={`summary-${item.id}`}>
              {item.changeSummary || item.description}
            </span>,
            shortId(item.checksum),
            <Status value={item.status} />,
            <span key={`time-${item.id}`}>
              {shortId(item.activatedBy || item.createdBy)}
              <small className="tableSubline">
                {formatDateTime(item.activatedAt || item.createdAt)}
              </small>
            </span>,
            item.status === 'superseded' ? (
              <button
                className="tableLink"
                type="button"
                onClick={() => {
                  setRollbackTarget(item);
                  setRollbackConfirmation('');
                }}
              >
                回滚到此版本
              </button>
            ) : (
              '—'
            ),
          ])}
          empty="尚无数据库配置版本。"
        />
      </Panel>

      {rollbackTarget ? (
        <section className="rollbackPanel">
          <div>
            <p className="eyebrow">CONTROLLED ROLLBACK</p>
            <h3>回滚到 v{rollbackTarget.version}</h3>
            <p>系统会创建新的生效版本，不会修改或删除任何历史记录。</p>
          </div>
          <label>
            回滚原因
            <input
              value={rollbackSummary}
              onChange={(event) => setRollbackSummary(event.target.value)}
            />
          </label>
          <label>
            输入 <code>{`回滚配置至版本:${rollbackTarget.version}`}</code>
            <input
              value={rollbackConfirmation}
              onChange={(event) => setRollbackConfirmation(event.target.value)}
            />
          </label>
          <div>
            <button type="button" onClick={() => setRollbackTarget(undefined)}>
              取消
            </button>
            <button
              className="dangerAction"
              type="button"
              disabled={
                Boolean(busy) ||
                !rollbackSummary.trim() ||
                rollbackConfirmation !== `回滚配置至版本:${rollbackTarget.version}`
              }
              onClick={() => void rollback()}
            >
              {busy === 'rollback' ? '回滚中…' : '确认回滚'}
            </button>
          </div>
        </section>
      ) : null}

      <div className="configGroups">
        {groups.map((group) => {
          const items = snapshot.configuration.filter((item) => item.group === group);
          return (
            <Panel
              key={group}
              title={group}
              eyebrow="BOOTSTRAP CONFIG"
              action={`${items.length} 项`}
            >
              <div className="configList">
                {items.map((item) => (
                  <article key={item.key}>
                    <div>
                      <strong>{item.key}</strong>
                      <small>
                        {item.source === 'credential_reference'
                          ? '受保护凭据引用'
                          : item.source === 'environment'
                            ? '环境变量'
                            : '使用默认值'}
                      </small>
                    </div>
                    <Status value={item.configured ? 'configured' : 'default'} />
                    {item.restartRequired ? (
                      <span className="restartTag">需重启</span>
                    ) : (
                      <span className="hotTag">运行时</span>
                    )}
                  </article>
                ))}
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel title="操作说明" eyebrow="CONFIG PLAYBOOK" action="5 步闭环">
        <ol className="configPlaybook">
          <li>
            <span>1</span>
            <div>
              <strong>从生效版本创建草稿</strong>
              <p>每次只保留一个可编辑草稿，历史发布版本不可修改。</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>调整允许列表参数</strong>
              <p>页面不会接收任意键，更不会接收 Secret、Token 或密码。</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>校验并保存</strong>
              <p>范围、类型、默认值和校验和均由服务端重新计算。</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>精确确认后发布</strong>
              <p>发布人、版本和校验和写入审计，生效版本始终唯一。</p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>异常时受控回滚</strong>
              <p>回滚会复制历史配置并产生新版本，完整保留证据链。</p>
            </div>
          </li>
        </ol>
      </Panel>
    </div>
  );
}

function DeliveryPage({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <div className="twoColumn">
      <Panel title="发布版本" eyebrow="RELEASES" action={`${snapshot.data.releases.length} 条`}>
        <DataTable
          columns={['版本', '提交', '环境', '状态', '发布时间']}
          rows={snapshot.data.releases.map((item) => [
            value(item.version),
            shortId(item.commitSha),
            value(item.environment),
            <Status value={value(item.status)} />,
            formatDateTime(item.deployedAt || item.createdAt),
          ])}
          empty="尚无发布记录；P7 将接入部署流水线。"
        />
      </Panel>
      <Panel
        title="备份与恢复演练"
        eyebrow="BACKUP & RESTORE"
        action={`${snapshot.data.backups.length} 条`}
      >
        <DataTable
          columns={['类型', '状态', '加密', '完成时间', '恢复验证']}
          rows={snapshot.data.backups.map((item) => [
            value(item.backupType),
            <Status value={value(item.status)} />,
            item.encrypted ? '是' : '否',
            formatDateTime(item.completedAt),
            formatDateTime(item.restoreVerifiedAt),
          ])}
          empty="尚无备份记录；P7 将执行真实加密备份与异机恢复。"
        />
      </Panel>
    </div>
  );
}

function OperationsPage(props: {
  snapshot: AdminSnapshot;
  identity: AdminIdentity;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [action, setAction] = useState<AdminOperation['action']>('cancel');
  const [targetId, setTargetId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = actionMeta[action];
  const expected = `${meta.confirmation}:${targetId}`;
  const submit = async () => {
    setBusy(true);
    try {
      await submitAdminAction(props.identity, {
        action,
        targetType: meta.targetType,
        targetId,
        confirmation,
      });
      setTargetId('');
      setConfirmation('');
      await props.onRefresh();
    } catch (reason: unknown) {
      props.onError(reason instanceof Error ? reason.message : '运维操作提交失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="operationsLayout">
      <Panel title="发起运维操作" eyebrow="RISK CONTROL" action={`风险：${meta.risk}`}>
        <div className="operationForm">
          <label>
            操作类型
            <select
              value={action}
              onChange={(event) => {
                setAction(event.target.value as AdminOperation['action']);
                setConfirmation('');
              }}
            >
              {Object.entries(actionMeta).map(([key, item]) => (
                <option key={key} value={key}>
                  {item.label} · {item.risk}风险
                </option>
              ))}
            </select>
          </label>
          <label>
            目标 ID
            <input
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              placeholder={meta.targetType === 'task' ? '任务 UUID' : `${meta.targetType} ID`}
            />
          </label>
          <div className={`riskNotice ${meta.risk === '严重' ? 'critical' : ''}`}>
            <strong>{meta.label}</strong>
            <p>
              {action === 'cancel'
                ? '确认后立即请求取消；执行结果写入审计。'
                : '该操作不会直接执行，将保持待审批状态并写入审计。'}
            </p>
          </div>
          <label>
            输入确认文本
            <code>{expected || `${meta.confirmation}:目标ID`}</code>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="完整输入上方确认文本"
            />
          </label>
          <button
            className="dangerButton"
            type="button"
            disabled={busy || !targetId || confirmation !== expected}
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : action === 'cancel' ? '确认并执行' : '提交审批申请'}
          </button>
        </div>
      </Panel>
      <Panel
        title="操作审计"
        eyebrow="ADMIN OPERATIONS"
        action={`${props.snapshot.data.operations.length} 条`}
      >
        <DataTable
          columns={['时间', '操作', '目标', '风险', '申请人', '状态']}
          rows={props.snapshot.data.operations.map((item) => [
            formatDateTime(item.createdAt),
            statusLabel(item.action),
            `${item.targetType}/${shortId(item.targetId)}`,
            <Risk value={item.riskLevel} />,
            shortId(item.requestedBy),
            <Status value={item.status} />,
          ])}
        />
      </Panel>
    </div>
  );
}

function GuidePage({
  snapshot,
  onNavigate,
}: {
  snapshot: AdminSnapshot;
  onNavigate: (page: PageId) => void;
}) {
  const allowed = new Set(snapshot.viewer.capabilities.allowedPages);
  const workflows = [
    {
      page: 'overview' as const,
      number: '01',
      title: '每日巡检',
      detail: '先看严重告警、服务健康、任务成功率和队列积压。',
    },
    {
      page: 'approvals' as const,
      number: '02',
      title: '处理审批',
      detail: '核对申请人、资源、风险和过期时间后再决定。',
    },
    {
      page: 'access' as const,
      number: '03',
      title: '分配权限',
      detail: '使用最小角色；超级管理员只用于平台管理。',
    },
    {
      page: 'operations' as const,
      number: '04',
      title: '运维处置',
      detail: '输入精确确认文本，高风险操作进入审批状态机。',
    },
    {
      page: 'trace' as const,
      number: '05',
      title: '故障定位',
      detail: '从任务沿来源事件、执行器和工具事件定位根因。',
    },
    {
      page: 'delivery' as const,
      number: '06',
      title: '发布与恢复',
      detail: '先核验备份和配置版本，再发起回滚或恢复演练。',
    },
  ].filter((item) => allowed.has(item.page));
  return (
    <div className="guideLayout">
      <section className="guideHero">
        <div>
          <p className="eyebrow">OPERATION HANDBOOK</p>
          <h2>管理中心操作说明书</h2>
          <p>
            当前账号为“{snapshot.viewer.roleIds.map(roleLabel).join('、')}
            ”，下面只列出你可以使用的流程。
          </p>
        </div>
        <div className="guideRoleCard">
          <span>{snapshot.viewer.capabilities.isSuperAdmin ? '超' : '员'}</span>
          <div>
            <strong>
              {snapshot.viewer.capabilities.isSuperAdmin ? '最高权限会话' : '受限权限会话'}
            </strong>
            <small>{snapshot.viewer.capabilities.allowedPages.length} 个可访问页面</small>
          </div>
        </div>
      </section>
      <Panel title="标准操作流程" eyebrow="DAILY PLAYBOOK" action={`${workflows.length} 项`}>
        <div className="workflowGrid">
          {workflows.map((item) => (
            <button key={item.page} type="button" onClick={() => onNavigate(item.page)}>
              <span>{item.number}</span>
              <div>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </div>
              <b>打开 →</b>
            </button>
          ))}
        </div>
      </Panel>
      <div className="twoColumn">
        <Panel title="角色权限说明" eyebrow="ROLE MATRIX">
          <div className="manualList">
            <article>
              <strong>只读成员</strong>
              <p>查看概览、任务、队列、执行器和企业系统集成，不可发起运维或修改权限。</p>
            </article>
            <article>
              <strong>运行操作员</strong>
              <p>在只读能力上增加 Trace、告警确认和受治理运维操作。</p>
            </article>
            <article>
              <strong>审批员</strong>
              <p>只处理高风险操作审批，受职责分离和禁止自批约束。</p>
            </article>
            <article>
              <strong>审计员</strong>
              <p>查看脱敏 Trace 与审计记录，不执行平台变更。</p>
            </article>
            <article>
              <strong>超级管理员</strong>
              <p>管理成员、配置、预算、发布和运维；仍不能绕过审批与审计。</p>
            </article>
          </div>
        </Panel>
        <Panel title="安全操作规则" eyebrow="SAFETY RULES">
          <ol className="safetySteps">
            <li>
              <span>1</span>
              <div>
                <strong>先确认范围</strong>
                <p>核对目标 ID、环境、影响面和当前状态。</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>使用最小权限</strong>
                <p>日常操作不要使用超级管理员账号。</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>高风险先审批</strong>
                <p>重试、清理、重启和回滚不会直接执行。</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>操作后复核</strong>
                <p>检查结果、告警、Trace 和审计记录是否一致。</p>
              </div>
            </li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function Metric({
  label,
  value: itemValue,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  tone: string;
}) {
  return (
    <article className={`metricCard ${tone}`}>
      <span>{label}</span>
      <strong>{itemValue}</strong>
      <small>{detail}</small>
    </article>
  );
}
function Panel({
  title,
  eyebrow,
  action,
  children,
  wide = false,
}: {
  title: string;
  eyebrow: string;
  action?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`panel ${wide ? 'wide' : ''}`}>
      <div className="panelHeader">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        {action ? <span>{action}</span> : null}
      </div>
      {children}
    </section>
  );
}
function ServiceCard({ service }: { service: AdminSnapshot['services'][number] }) {
  return (
    <article className="serviceCard">
      <div className={`serviceIcon ${service.status}`}>
        {service.service.slice(0, 1).toUpperCase()}
      </div>
      <div>
        <strong>{service.service}</strong>
        <small>
          {service.version || 'runtime'} · {service.latencyMs} ms
        </small>
      </div>
      <Status value={service.status} />
    </article>
  );
}
function QueueBars({ queue }: { queue: AdminSnapshot['queue'] }) {
  const entries: Array<[string, number, string]> = [
    ['等待', queue.waiting, 'blue'],
    ['执行中', queue.active, 'purple'],
    ['延迟', queue.delayed, 'amber'],
    ['失败', queue.failed, 'red'],
    ['死信', queue.deadLettered, 'deepred'],
    ['完成', queue.completed, 'green'],
  ];
  const max = Math.max(...entries.map(([, count]) => count), 1);
  return (
    <div className="queueBars">
      {entries.map(([label, count, tone]) => (
        <div key={label}>
          <span>{label}</span>
          <div>
            <i
              className={tone}
              style={{ width: `${Math.max(count > 0 ? 3 : 0, (count / max) * 100)}%` }}
            />
          </div>
          <strong>{count}</strong>
        </div>
      ))}
    </div>
  );
}
function TaskTable({
  tasks,
  onOpenTrace,
}: {
  tasks: Array<Record<string, unknown>>;
  onOpenTrace: (taskId: string) => Promise<void>;
}) {
  return (
    <DataTable
      columns={['任务 ID', '摘要', '执行器', '风险', '状态', '尝试', '更新时间', '']}
      rows={tasks.map((item) => [
        shortId(item.id),
        <span className="summaryCell">{value(item.inputSummary, '无摘要')}</span>,
        value(item.executor, '待路由'),
        <Risk value={value(item.riskLevel)} />,
        <Status value={value(item.status)} />,
        `${value(item.attemptCount, '0')}/${value(item.maxAttempts, '—')}`,
        formatDateTime(item.updatedAt),
        <button
          className="tableLink"
          type="button"
          onClick={() => void onOpenTrace(value(item.id))}
        >
          Trace →
        </button>,
      ])}
    />
  );
}
function DataTable({
  columns,
  rows,
  empty = '暂无数据',
}: {
  columns: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="emptyCell" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
function Status({ value: itemValue }: { value: string }) {
  return (
    <span className={`statusBadge ${toneForStatus(itemValue)}`}>
      <i />
      {statusLabel(itemValue)}
    </span>
  );
}
function Risk({ value: itemValue }: { value: string }) {
  return <span className={`riskBadge ${itemValue}`}>{riskLabel(itemValue)}</span>;
}
function AlertList({ alerts }: { alerts: AlertRecord[] }) {
  return (
    <div className="miniAlertList">
      {alerts.length > 0 ? (
        alerts.map((alert) => (
          <article key={alert.id}>
            <span className={alert.severity === 'critical' ? 'badDot' : 'warnDot'} />
            <div>
              <strong>{alert.title}</strong>
              <small>{alert.message}</small>
            </div>
            <time>{formatDateTime(alert.lastSeenAt)}</time>
          </article>
        ))
      ) : (
        <div className="inlineEmpty">✓ 当前没有开放告警</div>
      )}
    </div>
  );
}
function StatRow({
  label,
  value: itemValue,
  tone = '',
}: {
  label: string;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={tone}>{itemValue}</strong>
    </div>
  );
}
function ExecutorCard({
  name,
  state,
  detail,
  tone,
}: {
  name: string;
  state: string;
  detail: string;
  tone: string;
}) {
  return (
    <article className={`executorCard ${tone}`}>
      <span>⌘</span>
      <div>
        <h3>{name}</h3>
        <p>{detail}</p>
      </div>
      <strong>{state}</strong>
    </article>
  );
}
function TraceNode({
  label,
  detail,
  state,
}: {
  label: string;
  detail: string;
  state: 'done' | 'failed';
}) {
  return (
    <article className={state}>
      <span>{state === 'done' ? '✓' : '!'}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}
function LoginPage({
  loading,
  error,
  unauthorized,
  superAdmin,
  authConfig,
  onLogin,
}: {
  loading: boolean;
  error: string;
  unauthorized: boolean;
  superAdmin: boolean;
  authConfig: AdminAuthConfig;
  onLogin: (mode: 'standard' | 'super_admin') => void;
}) {
  return (
    <main className="loginShell">
      <section className="loginStory">
        <div className="loginBrand">
          <span>FA</span>
          <div>
            <strong>AgentOps</strong>
            <small>飞书智能体运营管理平台</small>
          </div>
        </div>
        <div className="loginStoryContent">
          <p className="eyebrow">ENTERPRISE AGENT CONTROL PLANE</p>
          <h1>让智能体运行、治理和运维都在一个中心完成。</h1>
          <p>覆盖任务、审批、权限、告警、集成、发布与审计，每一次管理操作都有身份、状态和记录。</p>
          <div className="loginFeatureGrid">
            <article>
              <strong>统一身份</strong>
              <span>仅使用企业飞书登录</span>
            </article>
            <article>
              <strong>最小权限</strong>
              <span>按角色开放页面与操作</span>
            </article>
            <article>
              <strong>高风险治理</strong>
              <span>确认、审批、幂等、审计</span>
            </article>
          </div>
        </div>
        <small className="loginFootnote">企业内网 · P7 管理控制面</small>
      </section>
      <section className="loginPanel">
        <div className="loginCard">
          <span className={superAdmin ? 'loginRoleMark super' : 'loginRoleMark'}>
            {superAdmin ? '超' : '飞'}
          </span>
          <p className="eyebrow">{superAdmin ? 'SUPER ADMINISTRATOR' : 'FEISHU SSO'}</p>
          <h2>{superAdmin ? '超级管理员入口' : '登录管理中心'}</h2>
          <p className="loginIntro">
            {superAdmin
              ? '仍然使用飞书验证身份，仅 administrator 角色可以建立最高权限会话。'
              : '登录后将根据你的 reader、operator、approver 或 auditor 角色展示对应功能。'}
          </p>
          {error ? <div className="loginError">{error}</div> : null}
          {unauthorized && !error ? (
            <div className="loginError">当前飞书身份尚未绑定平台角色。</div>
          ) : null}
          {authConfig.feishu.enabled ? (
            <button
              className="primaryButton full feishuLoginButton loginSubmit"
              type="button"
              onClick={() => onLogin(superAdmin ? 'super_admin' : 'standard')}
              disabled={loading}
            >
              <span className="feishuLoginMark">飞</span>
              {loading ? '正在连接飞书…' : superAdmin ? '以超级管理员身份登录' : '使用飞书登录'}
            </button>
          ) : (
            <div className="authUnavailable">飞书登录配置尚未生效。</div>
          )}
          <div className="safeNotice loginSafeNotice">
            <span>✓</span>
            <div>
              <strong>服务端安全会话</strong>
              <small>浏览器不保存飞书 Token、App Secret 或 Open ID。</small>
            </div>
          </div>
          <button
            className="loginSwitch"
            type="button"
            onClick={() => {
              window.location.hash = superAdmin ? 'overview' : 'super-admin-login';
            }}
          >
            {superAdmin ? '← 返回普通成员登录' : '超级管理员入口 →'}
          </button>
        </div>
      </section>
    </main>
  );
}

function readIdentity(): AdminIdentity {
  clearStoredIdentity();
  return emptyIdentity();
}

function hasIdentity(identity: AdminIdentity): boolean {
  return Boolean(
    identity.sessionToken || identity.actorId.trim() || identity.provider === 'feishu',
  );
}

function emptyIdentity(): AdminIdentity {
  return { actorId: '', groupIds: '' };
}

function clearStoredIdentity(): void {
  window.sessionStorage.removeItem('p6-admin-session');
  window.localStorage.removeItem('p6-admin-identity');
}

function consumeAuthCallbackResult(): { message: string; unauthorized: boolean } {
  const parameters = new URLSearchParams(window.location.search);
  const errorCode = parameters.get('auth_error');
  const completed = parameters.get('auth')?.startsWith('feishu') ?? false;
  if (errorCode || completed) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  }
  if (!errorCode) return { message: '', unauthorized: false };
  const messages: Record<string, string> = {
    FEISHU_ADMIN_NOT_AUTHORIZED: '飞书登录成功，但当前用户尚未绑定管理台角色。',
    FEISHU_SUPER_ADMIN_REQUIRED: '当前飞书用户不是平台超级管理员，请返回普通成员入口。',
    FEISHU_OAUTH_ACCESS_DENIED: '你取消了飞书授权，管理台没有建立登录会话。',
    FEISHU_OAUTH_INVALID_STATE: '飞书登录状态已过期或不匹配，请重新登录。',
    FEISHU_OAUTH_TOKEN_EXCHANGE_FAILED: '飞书授权码交换失败，请重新登录。',
    FEISHU_OAUTH_USER_INFO_FAILED: '未能获取飞书用户信息，请重新登录。',
    FEISHU_OAUTH_CODE_MISSING: '飞书回调缺少授权码，请重新登录。',
  };
  return {
    message: messages[errorCode] ?? '飞书登录失败，请重新尝试。',
    unauthorized: ['FEISHU_ADMIN_NOT_AUTHORIZED', 'FEISHU_SUPER_ADMIN_REQUIRED'].includes(
      errorCode,
    ),
  };
}

function adminErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '管理台数据加载失败，请稍后重试。';
}
function managedEditorValues(
  snapshot: AdminSnapshot,
  source?: ConfigVersion,
): ManagedConfiguration {
  return Object.fromEntries(
    snapshot.managedConfiguration.catalog.map((item) => [
      item.key,
      source?.configuration[item.key] ??
        snapshot.managedConfiguration.effective[item.key] ??
        item.defaultValue,
    ]),
  );
}
function configEditorSourceId(snapshot: AdminSnapshot): string {
  const draft = snapshot.data.configVersions.find((item) => item.status === 'draft');
  const active = snapshot.data.configVersions.find((item) => item.status === 'active');
  return draft?.id ?? active?.id ?? 'bootstrap';
}
function configDifferences(
  active: ConfigVersion | undefined,
  compared: ConfigVersion | undefined,
  catalog: AdminSnapshot['managedConfiguration']['catalog'],
): Array<{ key: string; label: string; before: string; after: string }> {
  if (!active || !compared || active.id === compared.id) return [];
  return catalog.flatMap((item) => {
    const before = active.configuration[item.key] ?? item.defaultValue;
    const after = compared.configuration[item.key] ?? item.defaultValue;
    return before === after
      ? []
      : [
          {
            key: item.key,
            label: item.label,
            before: `${before}${item.unit}`,
            after: `${after}${item.unit}`,
          },
        ];
  });
}
function readPageFromHash(): PageId {
  const candidate = window.location.hash.replace(/^#/, '').split('?')[0];
  return pages.some((item) => item.id === candidate) ? (candidate as PageId) : 'overview';
}
function isSuperAdminLoginHash(): boolean {
  return window.location.hash.replace(/^#/, '').split('?')[0] === 'super-admin-login';
}
function roleLabel(roleId: string): string {
  return (
    (
      {
        reader: '只读成员',
        operator: '运行操作员',
        approver: '审批员',
        auditor: '审计员',
        administrator: '超级管理员',
      } as Record<string, string>
    )[roleId] ?? roleId
  );
}
function value(item: unknown, fallback = ''): string {
  if (item === null || item === undefined || item === '') return fallback;
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    return String(item);
  return JSON.stringify(item);
}
function shortId(item: unknown): string {
  const text = value(item, '—');
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}
function formatDateTime(item: unknown): string {
  const text = value(item);
  if (!text) return '—';
  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? text
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .format(date)
        .replaceAll('/', '-');
}
function compactNumber(item: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(
    item,
  );
}
function formatCost(micros: number): string {
  return `成本 $${(micros / 1_000_000).toFixed(2)}`;
}
function riskLabel(item: string): string {
  return (
    (
      {
        low: '低',
        medium: '中',
        high: '高',
        critical: '严重',
        info: '提示',
        warning: '警告',
      } as Record<string, string>
    )[item] ?? item
  );
}
function statusLabel(item: string): string {
  return (
    (
      {
        queued: '排队中',
        running: '执行中',
        waiting_approval: '等待审批',
        succeeded: '成功',
        failed: '失败',
        cancelled: '已取消',
        expired: '已过期',
        pending: '待审批',
        approved: '已批准',
        rejected: '已拒绝',
        revoked: '已撤销',
        open: '开放',
        acknowledged: '已确认',
        resolved: '已恢复',
        ok: '正常',
        degraded: '降级',
        offline: '离线',
        ready: '就绪',
        disabled: '已关闭',
        incomplete: '未完成',
        configured: '已配置',
        protected: '启动配置保护',
        default: '默认值',
        active: '启用',
        superseded: '已替换',
        draft: '草稿',
        deployed: '已发布',
        completed: '已完成',
        pending_approval: '等待审批',
        executing: '执行中',
        cancel: '取消',
        retry: '重试',
        cleanup: '清理',
        restart: '重启',
        rollback: '回滚',
        tool_call: '工具调用',
        tool_result: '工具结果',
        started: '开始',
        progress: '进度',
      } as Record<string, string>
    )[item] ?? item
  );
}

function integrationSourceLabel(
  source: 'control-api' | 'windows-worker' | 'combined' | undefined,
): string {
  return (
    (
      {
        'control-api': 'Linux 控制面',
        'windows-worker': 'Windows Worker',
        combined: '控制面 + Worker',
      } as Record<string, string>
    )[source ?? ''] ?? '—'
  );
}
function toneForStatus(item: string): string {
  if (
    [
      'succeeded',
      'approved',
      'ok',
      'ready',
      'configured',
      'deployed',
      'completed',
      'active',
    ].includes(item)
  )
    return 'green';
  if (['failed', 'rejected', 'offline', 'critical'].includes(item)) return 'red';
  if (['waiting_approval', 'pending', 'pending_approval', 'warning', 'degraded'].includes(item))
    return 'amber';
  if (['running', 'executing'].includes(item)) return 'purple';
  if (['disabled', 'cancelled', 'resolved', 'superseded'].includes(item)) return 'muted';
  return 'blue';
}
