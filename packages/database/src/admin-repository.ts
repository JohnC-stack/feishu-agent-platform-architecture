import { randomUUID } from 'node:crypto';

import type { RiskLevel } from '@feishu-agent/contracts';
import type { JSONValue } from 'postgres';

import type { DatabaseClient } from './index.js';

export type AdminAction = 'cancel' | 'retry' | 'cleanup' | 'restart' | 'rollback';
export type AdminOperationStatus =
  'pending_approval' | 'executing' | 'succeeded' | 'failed' | 'rejected';

export interface OperationalAlertInput {
  key: string;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  source: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export interface OperationalAlertRecord extends OperationalAlertInput {
  id: string;
  status: 'open' | 'acknowledged' | 'resolved';
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
}

export interface AdminOperationRecord {
  id: string;
  action: AdminAction;
  targetType: string;
  targetId: string;
  riskLevel: RiskLevel;
  requestedBy: string;
  status: AdminOperationStatus;
  result: Record<string, unknown>;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface AdminDatabaseSnapshot {
  taskCounts: Record<string, number>;
  tasks: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  executorRuns: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  roleBindings: Array<Record<string, unknown>>;
  budgets: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
  alerts: OperationalAlertRecord[];
  operations: AdminOperationRecord[];
  releases: Array<Record<string, unknown>>;
  backups: Array<Record<string, unknown>>;
  configVersions: Array<Record<string, unknown>>;
}

export interface AdminTaskTrace {
  task: Record<string, unknown>;
  taskEvents: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  executorRuns: Array<Record<string, unknown>>;
  executorEvents: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
}

export class AdminRepository {
  public constructor(private readonly sql: DatabaseClient) {}

  public async getSnapshot(limit = 50): Promise<AdminDatabaseSnapshot> {
    assertLimit(limit);
    const [
      taskCounts,
      tasks,
      conversations,
      approvals,
      executorRuns,
      roles,
      roleBindings,
      budgets,
      auditEvents,
      alerts,
      operations,
      releases,
      backups,
      configVersions,
    ] = await Promise.all([
      this.sql<Array<{ status: string; count: number }>>`
        SELECT status::text AS status, count(*)::int AS count
        FROM tasks
        GROUP BY status
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          id,
          correlation_id AS "correlationId",
          status::text,
          executor::text,
          risk::text AS "riskLevel",
          input_summary AS "inputSummary",
          error_code AS "errorCode",
          error_message AS "errorMessage",
          attempt_count AS "attemptCount",
          max_attempts AS "maxAttempts",
          queued_at AS "queuedAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt"
        FROM tasks
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          c.id,
          c.channel,
          c.chat_id AS "chatId",
          c.user_id AS "userId",
          left(coalesce(c.summary, ''), 300) AS summary,
          c.summary_version AS "summaryVersion",
          c.last_message_at AS "lastMessageAt",
          c.updated_at AS "updatedAt",
          count(m.id)::int AS "messageCount"
        FROM conversations c
        LEFT JOIN conversation_messages m ON m.conversation_id = c.id
        GROUP BY c.id
        ORDER BY c.updated_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          a.id,
          a.task_id AS "taskId",
          a.operation_id AS "operationId",
          a.requested_by AS "requestedBy",
          a.decided_by AS "decidedBy",
          a.status,
          a.decision_reason AS "decisionReason",
          a.expires_at AS "expiresAt",
          a.decided_at AS "decidedAt",
          a.created_at AS "createdAt",
          o.tool_name AS "toolName",
          o.risk::text AS "riskLevel",
          o.resource_type AS "resourceType",
          o.resource_id AS "resourceId"
        FROM approval_requests a
        LEFT JOIN governed_operations o ON o.id = a.operation_id
        ORDER BY a.created_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          id,
          task_id AS "taskId",
          attempt,
          requested_executor::text AS "requestedExecutor",
          executor::text,
          status,
          workspace_path AS "workspacePath",
          error_category AS "errorCategory",
          error_code AS "errorCode",
          error_message AS "errorMessage",
          started_at AS "startedAt",
          finished_at AS "finishedAt"
        FROM executor_runs
        ORDER BY started_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT id, name, description, system, permissions, updated_at AS "updatedAt"
        FROM governance_roles
        ORDER BY system DESC, id
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          principal_type AS "principalType",
          principal_id AS "principalId",
          role_id AS "roleId",
          managed_by AS "managedBy",
          created_at AS "createdAt"
        FROM governance_role_bindings
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          l.scope_type AS "scopeType",
          l.scope_id AS "scopeId",
          l.period,
          l.token_limit::text AS "tokenLimit",
          l.cost_limit_micros::text AS "costLimitMicros",
          coalesce(sum(u.tokens_used), 0)::text AS "tokensUsed",
          coalesce(sum(u.cost_micros_used), 0)::text AS "costMicrosUsed",
          max(u.updated_at) AS "updatedAt"
        FROM budget_limits l
        LEFT JOIN budget_usage u
          ON u.scope_type = l.scope_type
          AND u.scope_id = l.scope_id
          AND u.period = l.period
        WHERE l.enabled = true
        GROUP BY l.id
        ORDER BY max(u.updated_at) DESC NULLS LAST, l.updated_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          id::text,
          correlation_id AS "correlationId",
          actor_type AS "actorType",
          actor_id AS "actorId",
          action,
          resource_type AS "resourceType",
          resource_id AS "resourceId",
          outcome,
          details,
          redacted,
          created_at AS "createdAt"
        FROM audit_events
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit * 2, 200)}
      `,
      this.listAlerts(limit),
      this.listOperations(limit),
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          id,
          version,
          commit_sha AS "commitSha",
          environment,
          status,
          created_by AS "createdBy",
          notes,
          created_at AS "createdAt",
          deployed_at AS "deployedAt",
          rolled_back_at AS "rolledBackAt"
        FROM platform_releases
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          id,
          backup_type AS "backupType",
          status,
          storage_reference AS "storageReference",
          encrypted,
          checksum,
          created_by AS "createdBy",
          created_at AS "createdAt",
          completed_at AS "completedAt",
          restore_verified_at AS "restoreVerifiedAt"
        FROM platform_backups
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      this.sql<Array<Record<string, unknown>>>`
        SELECT
          id,
          version,
          checksum,
          status,
          configuration,
          created_by AS "createdBy",
          created_at AS "createdAt",
          activated_at AS "activatedAt"
        FROM platform_config_versions
        ORDER BY version DESC
        LIMIT ${limit}
      `,
    ]);
    return {
      taskCounts: Object.fromEntries(taskCounts.map((row) => [row.status, row.count])),
      tasks: normalizeDates(tasks),
      conversations: normalizeDates(conversations),
      approvals: normalizeDates(approvals),
      executorRuns: normalizeDates(executorRuns),
      roles: normalizeDates(roles),
      roleBindings: normalizeDates(roleBindings),
      budgets: normalizeDates(budgets),
      auditEvents: normalizeDates(auditEvents),
      alerts,
      operations,
      releases: normalizeDates(releases),
      backups: normalizeDates(backups),
      configVersions: normalizeDates(configVersions),
    };
  }

  public async getTaskTrace(taskId: string): Promise<AdminTaskTrace | undefined> {
    const tasks = await this.sql<Array<Record<string, unknown>>>`
      SELECT
        id,
        conversation_id AS "conversationId",
        source_event_id AS "sourceEventId",
        correlation_id AS "correlationId",
        status::text,
        executor::text,
        risk::text AS "riskLevel",
        input_summary AS "inputSummary",
        output,
        error_code AS "errorCode",
        error_message AS "errorMessage",
        attempt_count AS "attemptCount",
        max_attempts AS "maxAttempts",
        queued_at AS "queuedAt",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM tasks
      WHERE id = ${taskId}
    `;
    const task = tasks[0];
    if (!task) return undefined;
    const correlationId = scalarText(task.correlationId);
    const [taskEvents, attempts, executorRuns, executorEvents, approvals, auditEvents] =
      await Promise.all([
        this.sql<Array<Record<string, unknown>>>`
          SELECT sequence, kind, message, payload, created_at AS "createdAt"
          FROM task_events
          WHERE task_id = ${taskId}
          ORDER BY sequence
        `,
        this.sql<Array<Record<string, unknown>>>`
          SELECT
            attempt,
            worker_id AS "workerId",
            started_at AS "startedAt",
            heartbeat_at AS "heartbeatAt",
            finished_at AS "finishedAt",
            outcome,
            error_code AS "errorCode",
            error_message AS "errorMessage"
          FROM task_attempts
          WHERE task_id = ${taskId}
          ORDER BY attempt
        `,
        this.sql<Array<Record<string, unknown>>>`
          SELECT
            id,
            attempt,
            requested_executor::text AS "requestedExecutor",
            executor::text,
            status,
            workspace_path AS "workspacePath",
            error_category AS "errorCategory",
            error_code AS "errorCode",
            error_message AS "errorMessage",
            started_at AS "startedAt",
            finished_at AS "finishedAt"
          FROM executor_runs
          WHERE task_id = ${taskId}
          ORDER BY attempt
        `,
        this.sql<Array<Record<string, unknown>>>`
          SELECT
            run_id AS "runId",
            sequence,
            executor::text,
            kind,
            message,
            payload,
            created_at AS "createdAt"
          FROM executor_events
          WHERE task_id = ${taskId}
          ORDER BY created_at, sequence
        `,
        this.sql<Array<Record<string, unknown>>>`
          SELECT
            id,
            requested_by AS "requestedBy",
            decided_by AS "decidedBy",
            status,
            decision_reason AS "decisionReason",
            expires_at AS "expiresAt",
            decided_at AS "decidedAt",
            created_at AS "createdAt"
          FROM approval_requests
          WHERE task_id = ${taskId}
          ORDER BY created_at
        `,
        this.sql<Array<Record<string, unknown>>>`
          SELECT
            id::text,
            actor_type AS "actorType",
            actor_id AS "actorId",
            action,
            resource_type AS "resourceType",
            resource_id AS "resourceId",
            outcome,
            details,
            created_at AS "createdAt"
          FROM audit_events
          WHERE correlation_id IN (${taskId}, ${correlationId})
          ORDER BY created_at
        `,
      ]);
    return {
      task: normalizeRecord(task),
      taskEvents: normalizeDates(taskEvents),
      attempts: normalizeDates(attempts),
      executorRuns: normalizeDates(executorRuns),
      executorEvents: normalizeDates(executorEvents),
      approvals: normalizeDates(approvals),
      auditEvents: normalizeDates(auditEvents),
    };
  }

  public async reconcileAlerts(active: readonly OperationalAlertInput[]): Promise<void> {
    const activeKeys = active.map((alert) => alert.key);
    await this.sql.begin(async (transaction) => {
      for (const alert of active) {
        await transaction`
          INSERT INTO operational_alerts (
            alert_key,
            severity,
            category,
            title,
            message,
            source,
            correlation_id,
            details,
            status,
            first_seen_at,
            last_seen_at,
            updated_at
          ) VALUES (
            ${alert.key},
            ${alert.severity},
            ${alert.category},
            ${alert.title},
            ${alert.message},
            ${alert.source},
            ${alert.correlationId ?? null},
            ${transaction.json(toJsonValue(alert.details ?? {}))},
            'open',
            now(),
            now(),
            now()
          )
          ON CONFLICT (alert_key)
          DO UPDATE SET
            severity = EXCLUDED.severity,
            category = EXCLUDED.category,
            title = EXCLUDED.title,
            message = EXCLUDED.message,
            source = EXCLUDED.source,
            correlation_id = EXCLUDED.correlation_id,
            details = EXCLUDED.details,
            status = CASE
              WHEN operational_alerts.status = 'resolved' THEN 'open'
              ELSE operational_alerts.status
            END,
            resolved_at = NULL,
            last_seen_at = now(),
            updated_at = now()
        `;
      }
      if (activeKeys.length === 0) {
        await transaction`
          UPDATE operational_alerts
          SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE status <> 'resolved'
        `;
      } else {
        await transaction`
          UPDATE operational_alerts
          SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE status <> 'resolved'
            AND alert_key NOT IN ${transaction(activeKeys)}
        `;
      }
    });
  }

  public async acknowledgeAlert(alertId: string, actorId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE operational_alerts
      SET
        status = 'acknowledged',
        acknowledged_by = ${actorId},
        acknowledged_at = now(),
        updated_at = now()
      WHERE id = ${alertId}
        AND status = 'open'
      RETURNING id
    `;
    return rows.length === 1;
  }

  public async createOperation(input: {
    action: AdminAction;
    targetType: string;
    targetId: string;
    riskLevel: RiskLevel;
    requestedBy: string;
    confirmation: string;
    status: AdminOperationStatus;
  }): Promise<AdminOperationRecord> {
    const id = randomUUID();
    const rows = await this.sql<Array<Record<string, unknown>>>`
      INSERT INTO admin_operations (
        id,
        action,
        target_type,
        target_id,
        risk,
        requested_by,
        confirmation,
        status
      ) VALUES (
        ${id},
        ${input.action},
        ${input.targetType},
        ${input.targetId},
        ${input.riskLevel},
        ${input.requestedBy},
        ${input.confirmation},
        ${input.status}
      )
      RETURNING
        id,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        risk::text AS "riskLevel",
        requested_by AS "requestedBy",
        status,
        result,
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        finished_at AS "finishedAt"
    `;
    return mapOperation(rows[0]);
  }

  public async finishOperation(input: {
    operationId: string;
    status: Extract<AdminOperationStatus, 'succeeded' | 'failed' | 'rejected'>;
    result?: Record<string, unknown>;
    errorCode?: string;
  }): Promise<AdminOperationRecord> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      UPDATE admin_operations
      SET
        status = ${input.status},
        result = ${this.sql.json(toJsonValue(input.result ?? {}))},
        error_code = ${input.errorCode ?? null},
        updated_at = now(),
        finished_at = now()
      WHERE id = ${input.operationId}
      RETURNING
        id,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        risk::text AS "riskLevel",
        requested_by AS "requestedBy",
        status,
        result,
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        finished_at AS "finishedAt"
    `;
    return mapOperation(rows[0]);
  }

  private async listAlerts(limit: number): Promise<OperationalAlertRecord[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT
        id,
        alert_key AS key,
        severity,
        category,
        title,
        message,
        source,
        status,
        correlation_id AS "correlationId",
        details,
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        acknowledged_by AS "acknowledgedBy",
        acknowledged_at AS "acknowledgedAt",
        resolved_at AS "resolvedAt"
      FROM operational_alerts
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        last_seen_at DESC
      LIMIT ${limit}
    `;
    return rows.map(mapAlert);
  }

  private async listOperations(limit: number): Promise<AdminOperationRecord[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT
        id,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        risk::text AS "riskLevel",
        requested_by AS "requestedBy",
        status,
        result,
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        finished_at AS "finishedAt"
      FROM admin_operations
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(mapOperation);
  }
}

function mapAlert(row: Record<string, unknown>): OperationalAlertRecord {
  return {
    id: String(row.id),
    key: String(row.key),
    severity: row.severity as OperationalAlertRecord['severity'],
    category: String(row.category),
    title: String(row.title),
    message: String(row.message),
    source: String(row.source),
    status: row.status as OperationalAlertRecord['status'],
    ...(row.correlationId ? { correlationId: scalarText(row.correlationId) } : {}),
    details: asRecord(row.details),
    firstSeenAt: asIso(row.firstSeenAt),
    lastSeenAt: asIso(row.lastSeenAt),
    ...(row.acknowledgedBy ? { acknowledgedBy: scalarText(row.acknowledgedBy) } : {}),
    ...(row.acknowledgedAt ? { acknowledgedAt: asIso(row.acknowledgedAt) } : {}),
    ...(row.resolvedAt ? { resolvedAt: asIso(row.resolvedAt) } : {}),
  };
}

function mapOperation(row: Record<string, unknown> | undefined): AdminOperationRecord {
  if (!row) throw new Error('Admin operation query returned no row.');
  return {
    id: String(row.id),
    action: row.action as AdminAction,
    targetType: String(row.targetType),
    targetId: String(row.targetId),
    riskLevel: row.riskLevel as RiskLevel,
    requestedBy: String(row.requestedBy),
    status: row.status as AdminOperationStatus,
    result: asRecord(row.result),
    ...(row.errorCode ? { errorCode: scalarText(row.errorCode) } : {}),
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
    ...(row.finishedAt ? { finishedAt: asIso(row.finishedAt) } : {}),
  };
}

function normalizeDates(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(normalizeRecord);
}

function normalizeRecord(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Admin snapshot limit must be an integer between 1 and 200.');
  }
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
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
