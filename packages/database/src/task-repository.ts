import { randomUUID } from 'node:crypto';

import {
  ExecutorEventSchema,
  RouteRuleSchema,
  TaskRequestSchema,
  type ConversationMessage,
  type ConversationRole,
  type RouteDecision,
  type RouteRule,
  type ExecutorEvent,
  type ExecutorExecutionResult,
  type ExecutorKind,
  type TaskRequest,
  type TaskStatus,
} from '@feishu-agent/contracts';
import { assertTransition } from '@feishu-agent/policy';
import type postgres from 'postgres';

import type { DatabaseClient } from './index.js';

interface ConversationRow {
  id: string;
  summary: string | null;
  summary_version: number;
}

interface TaskRow {
  id: string;
  conversation_id: string | null;
  source_event_id: string;
  correlation_id: string;
  status: TaskStatus;
  executor: RouteDecision['executor'] | null;
  route_rule_id: string | null;
  route_rule_version: number | null;
  attempt_count: number;
  max_attempts: number;
}

interface RouteRuleRow {
  id: string;
  version: number;
  priority: number;
  enabled: boolean;
  condition: RouteRule['condition'];
  executor: RouteRule['executor'];
  description: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ConversationRole;
  content: string;
  source_message_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface TaskEventRow {
  sequence: number;
  kind: string;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface TaskExecutionRow {
  id: string;
  source_event_id: string;
  correlation_id: string;
  reply_target_id: string;
  executor: ExecutorKind;
  risk: TaskRequest['riskLevel'];
  input: {
    text: string;
    command?: string;
    attachments?: TaskRequest['input']['attachments'];
    metadata?: Record<string, unknown>;
  };
  created_at: Date;
  chat_id: string;
  user_id: string;
}

export interface ConversationIdentity {
  channel: 'feishu';
  chatId: string;
  userId: string;
}

export interface ConversationSnapshot extends ConversationIdentity {
  id: string;
  summary?: string;
  summaryVersion: number;
}

export interface ConversationContext extends ConversationSnapshot {
  messages: ConversationMessage[];
}

export interface PersistedTask {
  id: string;
  conversationId?: string;
  sourceEventId: string;
  correlationId: string;
  status: TaskStatus;
  executor?: RouteDecision['executor'];
  routeRuleId?: string;
  routeRuleVersion?: number;
  attemptCount: number;
  maxAttempts: number;
}

export interface TaskTimelineEvent {
  sequence: number;
  kind: string;
  message?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TaskAttemptRecord {
  attempt: number;
  workerId: string;
  startedAt: string;
  heartbeatAt?: string;
  finishedAt?: string;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'stalled';
  errorCode?: string;
  errorMessage?: string;
}

export interface ExecutorRunRecord {
  id: string;
  taskId: string;
  attempt: number;
  requestedExecutor: ExecutorKind;
  executor?: ExecutorKind;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  workspacePath?: string;
  sessionId?: string;
  output?: string;
  errorCode?: string;
  eventCount: number;
}

export class TaskRepository {
  public constructor(private readonly sql: DatabaseClient) {}

  public async getOrCreateConversation(
    identity: ConversationIdentity,
  ): Promise<ConversationSnapshot> {
    return this.sql.begin(async (transaction) => this.upsertConversation(transaction, identity));
  }

  public async createTask(input: {
    request: TaskRequest;
    route: RouteDecision;
    maxAttempts?: number;
  }): Promise<{ task: PersistedTask; created: boolean }> {
    const { request, route } = input;
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer.');
    }

    return this.sql.begin(async (transaction) => {
      const conversation = await this.upsertConversation(transaction, {
        channel: request.source.channel,
        chatId: request.source.chatId,
        userId: request.source.userId,
      });
      const storedInput = {
        ...request.input,
        metadata: request.metadata,
      };
      const inserted = await transaction<TaskRow[]>`
        INSERT INTO tasks (
          id,
          conversation_id,
          source_event_id,
          correlation_id,
          reply_target_id,
          status,
          executor,
          risk,
          input,
          idempotency_key,
          route_rule_id,
          route_rule_version,
          input_summary,
          max_attempts,
          created_at,
          updated_at
        ) VALUES (
          ${request.id},
          ${conversation.id},
          ${request.source.eventId},
          ${request.correlationId},
          ${request.source.replyTargetId},
          'queued',
          ${route.executor},
          ${request.riskLevel},
          ${transaction.json(toJsonValue(storedInput))},
          ${`task:${request.source.eventId}`},
          ${route.ruleId},
          ${route.ruleVersion},
          ${summarizeInput(request.input.text)},
          ${maxAttempts},
          ${request.createdAt},
          ${request.createdAt}
        )
        ON CONFLICT (source_event_id) DO NOTHING
        RETURNING
          id,
          conversation_id,
          source_event_id,
          correlation_id,
          status,
          executor,
          route_rule_id,
          route_rule_version,
          attempt_count,
          max_attempts
      `;

      const insertedTask = inserted[0];
      if (!insertedTask) {
        const existing = await transaction<TaskRow[]>`
          SELECT
            id,
            conversation_id,
            source_event_id,
            correlation_id,
            status,
            executor,
            route_rule_id,
            route_rule_version,
            attempt_count,
            max_attempts
          FROM tasks
          WHERE source_event_id = ${request.source.eventId}
        `;
        const existingTask = existing[0];
        if (!existingTask) {
          throw new Error('Idempotent task lookup failed after an insert conflict.');
        }
        return { task: mapTask(existingTask), created: false };
      }

      await transaction`
        INSERT INTO task_events (task_id, sequence, kind, message, payload, created_at)
        VALUES (
          ${request.id},
          0,
          'queued',
          'Task accepted for scheduling.',
          ${transaction.json({ route })},
          ${request.createdAt}
        )
      `;
      await transaction`
        INSERT INTO audit_events (
          correlation_id,
          actor_type,
          actor_id,
          action,
          resource_type,
          resource_id,
          outcome,
          details,
          created_at
        ) VALUES (
          ${request.correlationId},
          'feishu_user',
          ${request.source.userId},
          'task.created',
          'task',
          ${request.id},
          'accepted',
          ${transaction.json({ routeRuleId: route.ruleId, routeRuleVersion: route.ruleVersion })},
          ${request.createdAt}
        )
      `;
      return { task: mapTask(insertedTask), created: true };
    });
  }

  public async transitionTask(input: {
    taskId: string;
    to: TaskStatus;
    reason?: string;
    occurredAt?: string;
  }): Promise<PersistedTask> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction<TaskRow[]>`
        SELECT
          id,
          conversation_id,
          source_event_id,
          correlation_id,
          status,
          executor,
          route_rule_id,
          route_rule_version,
          attempt_count,
          max_attempts
        FROM tasks
        WHERE id = ${input.taskId}
        FOR UPDATE
      `;
      const current = selected[0];
      if (!current) {
        throw new Error(`Task not found: ${input.taskId}`);
      }
      assertTransition(current.status, input.to);
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const updated = await transaction<TaskRow[]>`
        UPDATE tasks
        SET
          status = ${input.to},
          started_at = CASE
            WHEN ${input.to} = 'running' AND started_at IS NULL THEN ${occurredAt}
            ELSE started_at
          END,
          finished_at = CASE
            WHEN ${input.to} IN ('succeeded', 'failed', 'cancelled', 'expired') THEN ${occurredAt}
            ELSE finished_at
          END,
          updated_at = ${occurredAt}
        WHERE id = ${input.taskId}
        RETURNING
          id,
          conversation_id,
          source_event_id,
          correlation_id,
          status,
          executor,
          route_rule_id,
          route_rule_version,
          attempt_count,
          max_attempts
      `;
      const next = updated[0];
      if (!next) {
        throw new Error(`Task transition update failed: ${input.taskId}`);
      }
      const sequenceRows = await transaction<{ sequence: number }[]>`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
        FROM task_events
        WHERE task_id = ${input.taskId}
      `;
      const sequence = sequenceRows[0]?.sequence;
      if (sequence === undefined) {
        throw new Error(`Task event sequence allocation failed: ${input.taskId}`);
      }
      await transaction`
        INSERT INTO task_events (task_id, sequence, kind, message, payload, created_at)
        VALUES (
          ${input.taskId},
          ${sequence},
          'status_changed',
          ${input.reason ?? null},
          ${transaction.json({ from: current.status, to: input.to })},
          ${occurredAt}
        )
      `;
      return mapTask(next);
    });
  }

  public async appendConversationMessage(input: {
    conversationId: string;
    role: ConversationRole;
    content: string;
    sourceMessageId?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO conversation_messages (
        id,
        conversation_id,
        role,
        content,
        source_message_id,
        metadata,
        created_at
      ) VALUES (
        ${id},
        ${input.conversationId},
        ${input.role},
        ${input.content},
        ${input.sourceMessageId ?? null},
        ${this.sql.json(toJsonValue(input.metadata ?? {}))},
        ${input.createdAt ?? new Date().toISOString()}
      )
      ON CONFLICT (conversation_id, source_message_id) DO NOTHING
      RETURNING id
    `;
    const insertedId = inserted[0]?.id;
    if (insertedId) {
      return { id: insertedId, created: true };
    }
    if (!input.sourceMessageId) {
      throw new Error('Conversation message insert returned no identifier.');
    }
    const existing = await this.sql<{ id: string }[]>`
      SELECT id
      FROM conversation_messages
      WHERE conversation_id = ${input.conversationId}
        AND source_message_id = ${input.sourceMessageId}
    `;
    const existingId = existing[0]?.id;
    if (!existingId) {
      throw new Error('Idempotent conversation message lookup failed.');
    }
    return { id: existingId, created: false };
  }

  public async getTask(taskId: string): Promise<PersistedTask | undefined> {
    const rows = await this.sql<TaskRow[]>`
      SELECT
        id,
        conversation_id,
        source_event_id,
        correlation_id,
        status,
        executor,
        route_rule_id,
        route_rule_version,
        attempt_count,
        max_attempts
      FROM tasks
      WHERE id = ${taskId}
    `;
    return rows[0] ? mapTask(rows[0]) : undefined;
  }

  public async getTaskExecutionRequest(taskId: string): Promise<TaskRequest | undefined> {
    const rows = await this.sql<TaskExecutionRow[]>`
      SELECT
        tasks.id,
        tasks.source_event_id,
        tasks.correlation_id,
        tasks.reply_target_id,
        tasks.executor,
        tasks.risk,
        tasks.input,
        tasks.created_at,
        conversations.chat_id,
        conversations.user_id
      FROM tasks
      INNER JOIN conversations ON conversations.id = tasks.conversation_id
      WHERE tasks.id = ${taskId}
    `;
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const metadata = row.input.metadata ?? {};
    return TaskRequestSchema.parse({
      id: row.id,
      source: {
        channel: 'feishu',
        eventId: row.source_event_id,
        chatId: row.chat_id,
        userId: row.user_id,
        replyTargetId: row.reply_target_id,
      },
      input: {
        text: row.input.text,
        ...(row.input.command ? { command: row.input.command } : {}),
        attachments: row.input.attachments ?? [],
      },
      requestedExecutor: row.executor,
      riskLevel: row.risk,
      correlationId: row.correlation_id,
      createdAt: row.created_at.toISOString(),
      metadata,
    });
  }

  public async beginExecutorRun(input: {
    runId: string;
    taskId: string;
    attempt: number;
    requestedExecutor: ExecutorKind;
    workspacePath?: string;
    sandboxKind?: 'local_workspace' | 'hyperv';
  }): Promise<{ runId: string; created: boolean }> {
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error('Executor run attempt must be a positive integer.');
    }
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<{ id: string }[]>`
        INSERT INTO executor_runs (
          id,
          task_id,
          attempt,
          requested_executor,
          status,
          workspace_path
        ) VALUES (
          ${input.runId},
          ${input.taskId},
          ${input.attempt},
          ${input.requestedExecutor},
          'running',
          ${input.workspacePath ?? null}
        )
        ON CONFLICT (task_id, attempt) DO NOTHING
        RETURNING id
      `;
      const insertedId = inserted[0]?.id;
      if (insertedId) {
        if (input.workspacePath) {
          await transaction`
            INSERT INTO workspace_bindings (
              run_id,
              task_id,
              workspace_path,
              sandbox_kind
            ) VALUES (
              ${insertedId},
              ${input.taskId},
              ${input.workspacePath},
              ${input.sandboxKind ?? 'local_workspace'}
            )
          `;
        }
        return { runId: insertedId, created: true };
      }
      const existing = await transaction<{ id: string }[]>`
        SELECT id
        FROM executor_runs
        WHERE task_id = ${input.taskId}
          AND attempt = ${input.attempt}
      `;
      const existingId = existing[0]?.id;
      if (!existingId) {
        throw new Error(`Executor run lookup failed: ${input.taskId}/${input.attempt}`);
      }
      return { runId: existingId, created: false };
    });
  }

  public async appendExecutorEvents(events: readonly ExecutorEvent[]): Promise<number> {
    if (events.length === 0) {
      return 0;
    }
    const validated = events.map((event) => ExecutorEventSchema.parse(event));
    return this.sql.begin(async (transaction) => {
      let inserted = 0;
      for (const event of validated) {
        const requiredValues = {
          runId: event.runId,
          taskId: event.taskId,
          executor: event.executor,
          correlationId: event.correlationId,
          attempt: event.attempt,
          sequence: event.sequence,
          kind: event.kind,
          createdAt: event.createdAt,
        };
        const missing = Object.entries(requiredValues).find(([, value]) => value === undefined);
        if (missing) {
          throw new Error(`Executor event is missing required field: ${missing[0]}`);
        }
        const rows = await transaction<{ id: number }[]>`
          INSERT INTO executor_events (
            run_id,
            task_id,
            executor,
            correlation_id,
            attempt,
            sequence,
            kind,
            message,
            payload,
            created_at
          ) VALUES (
            ${event.runId},
            ${event.taskId},
            ${event.executor},
            ${event.correlationId},
            ${event.attempt},
            ${event.sequence},
            ${event.kind},
            ${event.message ?? null},
            ${transaction.json(toJsonValue(event.payload))},
            ${event.createdAt}
          )
          ON CONFLICT (run_id, sequence) DO NOTHING
          RETURNING id
        `;
        inserted += rows.length;
      }
      return inserted;
    });
  }

  public async finishExecutorRun(result: ExecutorExecutionResult): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE executor_runs
      SET
        executor = ${result.executor},
        status = ${result.status},
        session_id = ${result.sessionId ?? null},
        output = ${result.output ?? null},
        error_category = ${result.failure?.category ?? null},
        error_code = ${result.failure?.code ?? null},
        error_message = ${result.failure?.message ?? null},
        error_retryable = ${result.failure?.retryable ?? null},
        finished_at = now()
      WHERE id = ${result.runId}
        AND status = 'running'
      RETURNING id
    `;
    if (rows.length !== 1) {
      throw new Error(`Active executor run not found: ${result.runId}`);
    }
    await this.sql`
      UPDATE workspace_bindings
      SET released_at = now()
      WHERE run_id = ${result.runId}
        AND released_at IS NULL
    `;
  }

  public async failExecutorRun(input: {
    runId: string;
    code: string;
    message: string;
    retryable: boolean;
  }): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE executor_runs
      SET
        status = 'failed',
        error_category = 'dependency',
        error_code = ${input.code},
        error_message = ${input.message.slice(0, 2_000)},
        error_retryable = ${input.retryable},
        finished_at = now()
      WHERE id = ${input.runId}
        AND status = 'running'
      RETURNING id
    `;
    if (rows.length !== 1) {
      throw new Error(`Active executor run not found: ${input.runId}`);
    }
    await this.sql`
      UPDATE workspace_bindings
      SET released_at = now()
      WHERE run_id = ${input.runId}
        AND released_at IS NULL
    `;
  }

  public async getExecutorRun(runId: string): Promise<ExecutorRunRecord | undefined> {
    const rows = await this.sql<
      {
        id: string;
        task_id: string;
        attempt: number;
        requested_executor: ExecutorKind;
        executor: ExecutorKind | null;
        status: ExecutorRunRecord['status'];
        workspace_path: string | null;
        session_id: string | null;
        output: string | null;
        error_code: string | null;
        event_count: number;
      }[]
    >`
      SELECT
        runs.id,
        runs.task_id,
        runs.attempt,
        runs.requested_executor,
        runs.executor,
        runs.status,
        runs.workspace_path,
        runs.session_id,
        runs.output,
        runs.error_code,
        COUNT(events.id)::integer AS event_count
      FROM executor_runs runs
      LEFT JOIN executor_events events ON events.run_id = runs.id
      WHERE runs.id = ${runId}
      GROUP BY runs.id
    `;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          taskId: row.task_id,
          attempt: row.attempt,
          requestedExecutor: row.requested_executor,
          ...(row.executor ? { executor: row.executor } : {}),
          status: row.status,
          ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
          ...(row.session_id ? { sessionId: row.session_id } : {}),
          ...(row.output ? { output: row.output } : {}),
          ...(row.error_code ? { errorCode: row.error_code } : {}),
          eventCount: row.event_count,
        }
      : undefined;
  }

  public async requestTaskCancellation(taskId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE tasks
      SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
      WHERE id = ${taskId}
        AND status IN ('queued', 'running', 'waiting_approval')
      RETURNING id
    `;
    return rows.length === 1;
  }

  public async startTaskAttempt(input: {
    taskId: string;
    attempt: number;
    workerId: string;
    startedAt?: string;
  }): Promise<void> {
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error('Task attempt number must be a positive integer.');
    }
    const startedAt = input.startedAt ?? new Date().toISOString();
    await this.sql.begin(async (transaction) => {
      const inserted = await transaction<{ id: number }[]>`
        INSERT INTO task_attempts (task_id, attempt, worker_id, started_at, heartbeat_at)
        VALUES (${input.taskId}, ${input.attempt}, ${input.workerId}, ${startedAt}, ${startedAt})
        ON CONFLICT (task_id, attempt)
        DO UPDATE SET
          worker_id = EXCLUDED.worker_id,
          heartbeat_at = EXCLUDED.heartbeat_at
        RETURNING id
      `;
      if (inserted.length !== 1) {
        throw new Error(`Task attempt could not be started: ${input.taskId}/${input.attempt}`);
      }
      await transaction`
        UPDATE tasks
        SET attempt_count = GREATEST(attempt_count, ${input.attempt}), updated_at = ${startedAt}
        WHERE id = ${input.taskId}
      `;
    });
  }

  public async finishTaskAttempt(input: {
    taskId: string;
    attempt: number;
    outcome: TaskAttemptRecord['outcome'];
    errorCode?: string;
    errorMessage?: string;
    finishedAt?: string;
  }): Promise<void> {
    if (!input.outcome) {
      throw new Error('Task attempt outcome is required.');
    }
    const rows = await this.sql<{ id: number }[]>`
      UPDATE task_attempts
      SET
        finished_at = ${input.finishedAt ?? new Date().toISOString()},
        outcome = ${input.outcome},
        error_code = ${input.errorCode ?? null},
        error_message = ${input.errorMessage?.slice(0, 2_000) ?? null}
      WHERE task_id = ${input.taskId}
        AND attempt = ${input.attempt}
        AND finished_at IS NULL
      RETURNING id
    `;
    if (rows.length !== 1) {
      throw new Error(`Active task attempt not found: ${input.taskId}/${input.attempt}`);
    }
  }

  public async markTaskDeadLettered(taskId: string, occurredAt?: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE tasks
      SET dead_lettered_at = COALESCE(dead_lettered_at, ${occurredAt ?? new Date().toISOString()}),
          updated_at = now()
      WHERE id = ${taskId}
      RETURNING id
    `;
    if (rows.length !== 1) {
      throw new Error(`Task not found while marking dead-lettered: ${taskId}`);
    }
  }

  public async getTaskAttempts(taskId: string): Promise<TaskAttemptRecord[]> {
    const rows = await this.sql<
      {
        attempt: number;
        worker_id: string;
        started_at: Date;
        heartbeat_at: Date | null;
        finished_at: Date | null;
        outcome: TaskAttemptRecord['outcome'] | null;
        error_code: string | null;
        error_message: string | null;
      }[]
    >`
      SELECT
        attempt,
        worker_id,
        started_at,
        heartbeat_at,
        finished_at,
        outcome,
        error_code,
        error_message
      FROM task_attempts
      WHERE task_id = ${taskId}
      ORDER BY attempt
    `;
    return rows.map((row) => ({
      attempt: row.attempt,
      workerId: row.worker_id,
      startedAt: row.started_at.toISOString(),
      ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at.toISOString() } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    }));
  }

  public async listRecoverableTasks(limit = 100): Promise<PersistedTask[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Recoverable task limit must be an integer between 1 and 1000.');
    }
    const rows = await this.sql<TaskRow[]>`
      SELECT
        id,
        conversation_id,
        source_event_id,
        correlation_id,
        status,
        executor,
        route_rule_id,
        route_rule_version,
        attempt_count,
        max_attempts
      FROM tasks
      WHERE status IN ('queued', 'running')
        AND cancel_requested_at IS NULL
        AND dead_lettered_at IS NULL
      ORDER BY queued_at, id
      LIMIT ${limit}
    `;
    return rows.map(mapTask);
  }

  public async saveRouteRules(rules: RouteRule[]): Promise<number> {
    if (rules.length === 0) {
      return 0;
    }
    return this.sql.begin(async (transaction) => {
      let saved = 0;
      for (const rule of rules) {
        const rows = await transaction<{ id: string }[]>`
          INSERT INTO route_rules (
            id,
            version,
            priority,
            enabled,
            condition,
            executor,
            description
          ) VALUES (
            ${rule.id},
            ${rule.version},
            ${rule.priority},
            ${rule.enabled},
            ${transaction.json(toJsonValue(rule.condition))},
            ${rule.executor},
            ${rule.description ?? null}
          )
          ON CONFLICT (id, version)
          DO UPDATE SET
            priority = EXCLUDED.priority,
            enabled = EXCLUDED.enabled,
            condition = EXCLUDED.condition,
            executor = EXCLUDED.executor,
            description = EXCLUDED.description
          RETURNING id
        `;
        saved += rows.length;
      }
      return saved;
    });
  }

  public async getActiveRouteRules(): Promise<RouteRule[]> {
    const rows = await this.sql<RouteRuleRow[]>`
      SELECT id, version, priority, enabled, condition, executor, description
      FROM (
        SELECT DISTINCT ON (id)
          id,
          version,
          priority,
          enabled,
          condition,
          executor,
          description
        FROM route_rules
        ORDER BY id, version DESC
      ) latest
      WHERE enabled = true
      ORDER BY priority DESC, id
    `;
    return rows.map((row) =>
      RouteRuleSchema.parse({
        id: row.id,
        version: row.version,
        priority: row.priority,
        enabled: row.enabled,
        condition: row.condition,
        executor: row.executor,
        ...(row.description ? { description: row.description } : {}),
      }),
    );
  }

  public async getConversationContext(
    identity: ConversationIdentity,
    recentMessageLimit = 20,
  ): Promise<ConversationContext | undefined> {
    if (
      !Number.isInteger(recentMessageLimit) ||
      recentMessageLimit < 1 ||
      recentMessageLimit > 100
    ) {
      throw new Error('recentMessageLimit must be an integer between 1 and 100.');
    }
    const conversations = await this.sql<ConversationRow[]>`
      SELECT id, summary, summary_version
      FROM conversations
      WHERE channel = ${identity.channel}
        AND chat_id = ${identity.chatId}
        AND user_id = ${identity.userId}
    `;
    const conversation = conversations[0];
    if (!conversation) {
      return undefined;
    }
    const rows = await this.sql<MessageRow[]>`
      SELECT id, conversation_id, role, content, source_message_id, metadata, created_at
      FROM conversation_messages
      WHERE conversation_id = ${conversation.id}
      ORDER BY created_at DESC, id DESC
      LIMIT ${recentMessageLimit}
    `;
    return {
      id: conversation.id,
      ...identity,
      ...(conversation.summary ? { summary: conversation.summary } : {}),
      summaryVersion: conversation.summary_version,
      messages: rows.reverse().map(mapMessage),
    };
  }

  public async updateConversationSummary(input: {
    conversationId: string;
    expectedVersion: number;
    summary: string;
  }): Promise<number> {
    const rows = await this.sql<{ summary_version: number }[]>`
      UPDATE conversations
      SET
        summary = ${input.summary},
        summary_version = summary_version + 1,
        updated_at = now()
      WHERE id = ${input.conversationId}
        AND summary_version = ${input.expectedVersion}
      RETURNING summary_version
    `;
    const version = rows[0]?.summary_version;
    if (version === undefined) {
      throw new Error('Conversation summary version conflict.');
    }
    return version;
  }

  public async getTaskTimeline(taskId: string): Promise<TaskTimelineEvent[]> {
    const rows = await this.sql<TaskEventRow[]>`
      SELECT sequence, kind, message, payload, created_at
      FROM task_events
      WHERE task_id = ${taskId}
      ORDER BY sequence
    `;
    return rows.map((row) => ({
      sequence: row.sequence,
      kind: row.kind,
      ...(row.message ? { message: row.message } : {}),
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }));
  }

  private async upsertConversation(
    transaction: postgres.TransactionSql,
    identity: ConversationIdentity,
  ): Promise<ConversationSnapshot> {
    const rows = await transaction<ConversationRow[]>`
      INSERT INTO conversations (channel, chat_id, user_id, updated_at)
      VALUES (${identity.channel}, ${identity.chatId}, ${identity.userId}, now())
      ON CONFLICT (channel, chat_id, user_id)
      DO UPDATE SET updated_at = now()
      RETURNING id, summary, summary_version
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('Conversation upsert returned no row.');
    }
    return {
      id: row.id,
      ...identity,
      ...(row.summary ? { summary: row.summary } : {}),
      summaryVersion: row.summary_version,
    };
  }
}

function summarizeInput(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}

function mapTask(row: TaskRow): PersistedTask {
  return {
    id: row.id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    sourceEventId: row.source_event_id,
    correlationId: row.correlation_id,
    status: row.status,
    ...(row.executor ? { executor: row.executor } : {}),
    ...(row.route_rule_id ? { routeRuleId: row.route_rule_id } : {}),
    ...(row.route_rule_version ? { routeRuleVersion: row.route_rule_version } : {}),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
  };
}

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
