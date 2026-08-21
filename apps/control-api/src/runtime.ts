import { randomUUID } from 'node:crypto';

import type { ExecutorExecutionResult, RouteRule } from '@feishu-agent/contracts';
import { createDatabaseClient, GovernanceRepository, TaskRepository } from '@feishu-agent/database';

import { createControlApi } from './app.js';
import { createFeishuGatewayApprovalCardSender } from './approval-card-sender.js';
import { ExecutorWorkerClient } from './executor-worker-client.js';
import { readGovernanceConfig } from './governance-config.js';
import { createGovernanceService } from './governance-service.js';
import { createTaskCoordinator } from './task-coordinator.js';
import { readTaskQueueConfig } from './task-queue-config.js';
import {
  TaskCancelledError,
  TaskNonRetryableError,
  TaskQueueRuntime,
  TaskTimeoutError,
} from './task-queue.js';

export const defaultRouteRules: RouteRule[] = [
  {
    id: 'enterprise-read-direct',
    version: 1,
    priority: 110,
    enabled: true,
    condition: { commands: ['/gitlab', '/confluence', '/feishu'] },
    executor: 'direct_tool',
    description: 'Route approved enterprise reads to deterministic read-only tools.',
  },
  {
    id: 'health-direct',
    version: 1,
    priority: 100,
    enabled: true,
    condition: { commands: ['/health', '/ping'] },
    executor: 'direct_tool',
    description: 'Route health probes to a deterministic direct tool.',
  },
  {
    id: 'agent-cli-command',
    version: 1,
    priority: 90,
    enabled: true,
    condition: { commands: ['/agent', '/code'] },
    executor: 'agent_cli',
    description: 'Route explicit code and workspace tasks to the Agent CLI.',
  },
];

export async function createControlApiRuntime() {
  const sql = createDatabaseClient();
  const repository = new TaskRepository(sql);
  const governance = createGovernanceService(
    new GovernanceRepository(sql),
    readGovernanceConfig(),
    createFeishuGatewayApprovalCardSender(),
  );
  await governance.initialize();
  await repository.saveRouteRules(defaultRouteRules);
  const rules = await repository.getActiveRouteRules();
  const queueConfig = readTaskQueueConfig();
  const queue = new TaskQueueRuntime(queueConfig);
  const apiAgentEnabled = readBooleanFeatureFlag(process.env.API_AGENT_ENABLED, false);
  const coordinator = createTaskCoordinator(
    repository,
    queue,
    rules,
    apiAgentEnabled ? 'api_agent' : 'agent_cli',
  );
  const workerClient = new ExecutorWorkerClient();
  const recovery = await coordinator.recoverPending();
  await coordinator.startWorker(async (data, context) => {
    const task = await repository.getTaskExecutionRequest(data.taskId);
    if (!task) {
      throw new TaskNonRetryableError(`Task execution payload not found: ${data.taskId}`);
    }
    const conversation = await repository.getConversationContext({
      channel: task.source.channel,
      chatId: task.source.chatId,
      userId: task.source.userId,
    });
    const executionTask = {
      ...task,
      metadata: {
        ...task.metadata,
        ...(conversation ? { conversationContext: formatConversationContext(conversation) } : {}),
      },
    };
    const workspacePath = readMetadataString(task.metadata, 'workspacePath');
    const previousSessionId = readMetadataString(task.metadata, 'previousSessionId');
    const started = await repository.beginExecutorRun({
      runId: randomUUID(),
      taskId: task.id,
      attempt: context.attempt,
      requestedExecutor: data.executor,
      ...(workspacePath ? { workspacePath } : {}),
      ...(workspacePath
        ? {
            sandboxKind: ['high', 'critical'].includes(task.riskLevel)
              ? 'hyperv'
              : 'local_workspace',
          }
        : {}),
    });
    let result: ExecutorExecutionResult;
    try {
      result = await workerClient.execute(
        {
          task: executionTask,
          executor: data.executor,
          runId: started.runId,
          attempt: context.attempt,
          approvedToolNames: approvedToolsFor(task),
          ...(workspacePath ? { workspacePath } : {}),
          ...(previousSessionId ? { previousSessionId } : {}),
        },
        context.signal,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.failExecutorRun({
        runId: started.runId,
        code: 'WINDOWS_WORKER_REQUEST_FAILED',
        message,
        retryable: true,
      });
      throw error;
    }
    await repository.appendExecutorEvents(result.events);
    await repository.finishExecutorRun(result);
    if (result.status === 'succeeded') {
      return {
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        outputReference: `executor-run:${result.runId}`,
      };
    }
    if (result.status === 'cancelled') {
      throw new TaskCancelledError(task.id);
    }
    if (result.status === 'expired') {
      throw new TaskTimeoutError(queueConfig.timeoutMs);
    }
    const message = result.failure?.message ?? `Executor run failed: ${result.runId}`;
    if (result.failure && !result.failure.retryable) {
      throw new TaskNonRetryableError(message);
    }
    throw new Error(message);
  });
  const app = createControlApi({
    coordinator,
    governance,
    readinessProbes: [
      {
        name: 'postgres',
        async check() {
          const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
          return rows[0]?.ok === 1;
        },
      },
      {
        name: 'bullmq',
        async check() {
          await queue.getSnapshot();
          return true;
        },
      },
      {
        name: 'windows_worker',
        check: () => workerClient.isReady(),
      },
    ],
    async onClose() {
      await queue.close();
      await sql.end();
    },
  });
  app.log.info(recovery, 'task queue recovery completed');
  return app;
}

function readBooleanFeatureFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error('API_AGENT_ENABLED must be true or false.');
}

export function approvedToolsFor(
  task: Awaited<ReturnType<TaskRepository['getTaskExecutionRequest']>>,
): string[] {
  if (!task) {
    return [];
  }
  if (task.requestedExecutor === 'agent_cli') {
    return [];
  }
  const command = task.input.command ?? task.input.text.trim().split(/\s+/, 1)[0];
  if (command?.toLowerCase() === '/ping') {
    return ['platform.ping'];
  }
  if (command?.toLowerCase() === '/gitlab') {
    return ['gitlab.read'];
  }
  if (command?.toLowerCase() === '/confluence') {
    return ['confluence.read'];
  }
  if (command?.toLowerCase() === '/feishu') {
    return ['feishu.read'];
  }
  return ['platform.health'];
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatConversationContext(
  conversation: NonNullable<Awaited<ReturnType<TaskRepository['getConversationContext']>>>,
): string {
  const lines = [conversation.summary ? `Summary: ${conversation.summary}` : ''];
  lines.push(...conversation.messages.map((message) => `${message.role}: ${message.content}`));
  return lines.filter(Boolean).join('\n').slice(-40_000);
}
