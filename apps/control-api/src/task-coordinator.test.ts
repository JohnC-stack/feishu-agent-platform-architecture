import { describe, expect, it } from 'vitest';

import type { PersistedTask } from '@feishu-agent/database';

import {
  TaskCoordinator,
  type TaskQueuePort,
  type TaskRepositoryPort,
} from './task-coordinator.js';

const request = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu' as const,
    eventId: 'event-1',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: '/health', attachments: [] },
  riskLevel: 'low' as const,
  correlationId: 'trace-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  metadata: {},
};

function persistedTask(status: PersistedTask['status'] = 'queued'): PersistedTask {
  return {
    id: request.id,
    conversationId: 'conversation-1',
    sourceEventId: request.source.eventId,
    correlationId: request.correlationId,
    status,
    executor: 'direct_tool',
    routeRuleId: 'health-direct',
    routeRuleVersion: 2,
    attemptCount: 0,
    maxAttempts: 3,
  };
}

function createHarness(fallbackExecutor: 'api_agent' | 'agent_cli' = 'api_agent') {
  const enqueued: string[] = [];
  const transitioned: string[] = [];
  const repository: TaskRepositoryPort = {
    createTask: () => Promise.resolve({ task: persistedTask(), created: true }),
    getTask: () => Promise.resolve(persistedTask()),
    listRecoverableTasks: () => Promise.resolve([persistedTask()]),
    requestTaskCancellation: () => Promise.resolve(true),
    startTaskAttempt: () => Promise.resolve(),
    finishTaskAttempt: () => Promise.resolve(),
    markTaskDeadLettered: () => Promise.resolve(),
    transitionTask(input) {
      transitioned.push(`${input.taskId}:${input.to}`);
      return Promise.resolve(persistedTask('cancelled'));
    },
  };
  const queue: TaskQueuePort = {
    enqueue(data) {
      enqueued.push(data.taskId);
      return Promise.resolve({ jobId: data.taskId, deduplicated: false });
    },
    cancel: () => Promise.resolve('cancelled'),
    startWorker: () => Promise.resolve(),
  };
  const coordinator = new TaskCoordinator(
    repository,
    queue,
    [
      {
        id: 'health-direct',
        version: 2,
        priority: 100,
        enabled: true,
        condition: { commands: ['/health'] },
        executor: 'direct_tool',
      },
    ],
    fallbackExecutor,
  );
  return { coordinator, enqueued, transitioned };
}

describe('TaskCoordinator', () => {
  it('persists the route decision before enqueueing a task reference', async () => {
    const { coordinator, enqueued } = createHarness();
    const result = await coordinator.submit(request, {
      chatType: 'group',
    });

    expect(result).toMatchObject({
      created: true,
      route: { executor: 'direct_tool', ruleId: 'health-direct', ruleVersion: 2 },
    });
    expect(enqueued).toEqual([request.id]);
  });

  it('routes unmatched tasks away from the API channel when its fallback is disabled', async () => {
    const { coordinator } = createHarness('agent_cli');
    const result = await coordinator.submit(
      { ...request, input: { text: 'Analyze this task', attachments: [] } },
      { chatType: 'p2p' },
    );

    expect(result.route).toMatchObject({ executor: 'agent_cli', ruleId: 'fallback' });
  });

  it('re-enqueues recoverable database tasks idempotently', async () => {
    const { coordinator, enqueued } = createHarness();
    await expect(coordinator.recoverPending()).resolves.toEqual({ scanned: 1, enqueued: 1 });
    expect(enqueued).toEqual([request.id]);
  });

  it('persists cancellation after removing a queued job', async () => {
    const { coordinator, transitioned } = createHarness();
    await expect(coordinator.cancel(request.id)).resolves.toBe('cancelled');
    expect(transitioned).toEqual([`${request.id}:cancelled`]);
  });
});
