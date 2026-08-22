import { randomUUID } from 'node:crypto';

import { TaskRequestSchema } from '@feishu-agent/contracts';
import { createDatabaseClient } from '@feishu-agent/database';

interface ReadyResponse {
  status: string;
}

interface AuthConfigResponse {
  feishu: { enabled: boolean };
  localBootstrapEnabled: boolean;
  manualIdentityEnabled: boolean;
}

const apiUrl = (process.env.CONTROL_API_INTERNAL_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const gatewayUrl = (process.env.FEISHU_GATEWAY_INTERNAL_URL ?? 'http://127.0.0.1:3100').replace(
  /\/$/,
  '',
);
const workerUrl = (process.env.WINDOWS_WORKER_URL ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const adminId = firstCsvValue(process.env.GOVERNANCE_ADMIN_USER_IDS);
if (!adminId) throw new Error('GOVERNANCE_ADMIN_USER_IDS must contain an administrator.');

const sql = createDatabaseClient();
const taskId = randomUUID();
const runId = randomUUID();
const chatId = `verify-p6-chat-${runId}`;
const task = TaskRequestSchema.parse({
  id: taskId,
  source: {
    channel: 'feishu',
    eventId: `verify-p6-event-${runId}`,
    chatId,
    userId: adminId,
    replyTargetId: `verify-p6-message-${runId}`,
  },
  input: { text: `/gitlab project __p6_forbidden_${runId}__` },
  correlationId: `verify-p6-correlation-${runId}`,
  createdAt: new Date().toISOString(),
});

try {
  const [controlReady, gatewayReady, workerReady, authConfig] = await Promise.all([
    fetchJson<ReadyResponse>(`${apiUrl}/health/ready`),
    fetchJson<ReadyResponse>(`${gatewayUrl}/health/ready`),
    fetchJson<ReadyResponse>(`${workerUrl}/health/ready`),
    fetchJson<AuthConfigResponse>(`${apiUrl}/v1/admin/auth/config`),
  ]);
  const [standardLogin, superAdminLogin, localSession, manualSnapshot] = await Promise.all([
    fetch(`${apiUrl}/v1/admin/auth/feishu/start`, { redirect: 'manual' }),
    fetch(`${apiUrl}/v1/admin/auth/feishu/super-admin/start`, { redirect: 'manual' }),
    fetch(`${apiUrl}/v1/admin/session/local`, { method: 'POST' }),
    fetch(`${apiUrl}/v1/admin/snapshot?limit=1`, {
      headers: { 'x-admin-actor-id': adminId },
    }),
  ]);

  await request('/v1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, context: { chatType: 'p2p' } }),
  });
  const failedTask = await waitForFailedTask(taskId);
  const taskRows = await sql<
    Array<{
      source_event_id: string;
      correlation_id: string;
      error_code: string | null;
      error_message: string | null;
    }>
  >`
    SELECT source_event_id, correlation_id, error_code, error_message
    FROM tasks
    WHERE id = ${taskId}
  `;
  const counts = await sql<
    Array<{
      attempts: number;
      runs: number;
      failed_runs: number;
      executor_events: number;
      tool_events: number;
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM task_attempts WHERE task_id = ${taskId}) AS attempts,
      (SELECT count(*)::int FROM executor_runs WHERE task_id = ${taskId}) AS runs,
      (
        SELECT count(*)::int
        FROM executor_runs
        WHERE task_id = ${taskId} AND status = 'failed'
          AND (error_code IS NOT NULL OR error_message IS NOT NULL)
      ) AS failed_runs,
      (SELECT count(*)::int FROM executor_events WHERE task_id = ${taskId}) AS executor_events,
      (
        SELECT count(*)::int
        FROM executor_events
        WHERE task_id = ${taskId} AND kind IN ('tool_call', 'tool_result')
      ) AS tool_events
  `;
  const authSerialized = JSON.stringify(authConfig);
  const configuredSecrets = [
    process.env.FEISHU_APP_SECRET,
    process.env.GITLAB_TOKEN,
    process.env.OPENAI_API_KEY,
    process.env.DATABASE_URL,
    process.env.REDIS_URL,
  ].filter((value): value is string => Boolean(value));
  const taskRow = taskRows[0];
  const traceCounts = counts[0];
  const results = {
    controlApiReady: controlReady.status === 'ok',
    feishuGatewayReady: gatewayReady.status === 'ok',
    windowsWorkerReady: workerReady.status === 'ok',
    feishuIsTheOnlyInteractiveLogin:
      authConfig.feishu.enabled &&
      !authConfig.localBootstrapEnabled &&
      !authConfig.manualIdentityEnabled,
    standardFeishuLoginAvailable: standardLogin.status === 302,
    superAdminFeishuLoginAvailable: superAdminLogin.status === 302,
    localAndManualBypassesClosed:
      localSession.status === 404 && [400, 401, 403].includes(manualSnapshot.status),
    syntheticFeishuTaskFailed: failedTask.status === 'failed',
    sourceAndCorrelationPersisted:
      taskRow?.source_event_id === task.source.eventId &&
      taskRow.correlation_id === task.correlationId,
    executionTracePersisted:
      (traceCounts?.attempts ?? 0) > 0 &&
      (traceCounts?.runs ?? 0) > 0 &&
      (traceCounts?.executor_events ?? 0) > 0 &&
      (traceCounts?.tool_events ?? 0) > 0,
    failurePersisted:
      Boolean(taskRow?.error_code ?? taskRow?.error_message) || (traceCounts?.failed_runs ?? 0) > 0,
    publicAuthConfigContainsNoSecrets: configuredSecrets.every(
      (secret) => !authSerialized.includes(secret),
    ),
  };
  if (Object.values(results).some((passed) => !passed)) {
    throw new Error(`P6 live verification failed: ${JSON.stringify(results)}`);
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await sql`DELETE FROM audit_events WHERE resource_type = 'task' AND resource_id = ${taskId}`;
  await sql`DELETE FROM tasks WHERE id = ${taskId}`;
  await sql`DELETE FROM conversations WHERE chat_id = ${chatId}`;
  await sql.end();
}

async function waitForFailedTask(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${apiUrl}/v1/tasks/${id}`);
    if (response.ok) {
      const current = (await response.json()) as Record<string, unknown>;
      if (current.status === 'failed') return current;
      if (['succeeded', 'cancelled', 'expired'].includes(String(current.status))) {
        throw new Error(
          `Synthetic failure task reached unexpected status: ${String(current.status)}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the synthetic P6 failure task.');
}

async function request<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return (await response.json()) as T;
}

function firstCsvValue(value: string | undefined): string {
  return value?.split(',')[0]?.trim() ?? '';
}
