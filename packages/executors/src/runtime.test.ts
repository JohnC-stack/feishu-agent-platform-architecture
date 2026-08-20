import { describe, expect, it } from 'vitest';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { ExecutorRuntimeError } from './errors.js';
import { ExecutorCircuitBreaker } from './circuit-breaker.js';
import { createExecutorEvent } from './events.js';
import { NoopExecutor } from './noop-executor.js';
import { ExecutorRuntime } from './runtime.js';
import type { Executor, ExecutorContext } from './types.js';

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-runtime',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: 'Run with fallback', attachments: [] },
  riskLevel: 'low',
  correlationId: 'trace-runtime',
  createdAt: '2026-08-20T00:00:00.000Z',
  metadata: {},
};

class FailingExecutor implements Executor {
  public readonly kind = 'api_agent' as const;

  public execute(taskRequest: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    void taskRequest;
    void context;
    throw new ExecutorRuntimeError(
      'dependency',
      'MODEL_UNAVAILABLE',
      'Model dependency is unavailable.',
      true,
    );
  }
}

class WaitingExecutor implements Executor {
  public readonly kind = 'api_agent' as const;

  public async *execute(
    taskRequest: TaskRequest,
    context: ExecutorContext,
  ): AsyncIterable<ExecutorEvent> {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        'abort',
        () => {
          const reason = context.signal.reason as unknown;
          reject(reason instanceof Error ? reason : new Error('Executor wait was cancelled.'));
        },
        { once: true },
      );
    });
    yield createExecutorEvent(taskRequest, context, this.kind, 0, 'completed');
  }
}

describe('ExecutorRuntime', () => {
  it('falls back after retryable failures and maintains one ordered event stream', async () => {
    const runtime = new ExecutorRuntime({
      executors: [new FailingExecutor(), new NoopExecutor('direct_tool')],
      fallbackOrder: { api_agent: ['direct_tool'] },
      limits: { timeoutMs: 5_000, maxOutputBytes: 20_000, maxEvents: 20 },
    });
    const result = await runtime.run(
      task,
      {
        signal: new AbortController().signal,
        runId: '26588a79-31ff-47b4-8c11-516fcbfb3f6f',
        attempt: 1,
        approvedToolNames: new Set(),
      },
      'api_agent',
    );

    expect(result.status).toBe('succeeded');
    expect(result.executor).toBe('direct_tool');
    expect(result.events.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(result.events[0]?.message).toContain('fallback');
  });

  it('maps cancellation to a terminal cancelled result', async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new ExecutorRuntime({ executors: [new NoopExecutor('direct_tool')] });
    const result = await runtime.run(
      task,
      {
        signal: controller.signal,
        runId: '26588a79-31ff-47b4-8c11-516fcbfb3f6f',
        attempt: 1,
        approvedToolNames: new Set(),
      },
      'direct_tool',
    );

    expect(result.status).toBe('cancelled');
    expect(result.failure?.category).toBe('cancelled');
  });

  it('enforces the overall executor timeout', async () => {
    const runtime = new ExecutorRuntime({
      executors: [new WaitingExecutor()],
      limits: { timeoutMs: 100, maxOutputBytes: 20_000, maxEvents: 20 },
    });
    const result = await runtime.run(
      task,
      {
        signal: new AbortController().signal,
        runId: '26588a79-31ff-47b4-8c11-516fcbfb3f6f',
        attempt: 1,
        approvedToolNames: new Set(),
      },
      'api_agent',
    );

    expect(result.status).toBe('expired');
    expect(result.failure?.code).toBe('EXECUTOR_TIMEOUT');
  });

  it('opens the circuit after the configured failure threshold', async () => {
    const breaker = new ExecutorCircuitBreaker({ failureThreshold: 1, resetAfterMs: 60_000 });
    const runtime = new ExecutorRuntime({
      executors: [new FailingExecutor(), new NoopExecutor('direct_tool')],
      fallbackOrder: { api_agent: ['direct_tool'] },
      circuitBreaker: breaker,
    });
    const context: ExecutorContext = {
      signal: new AbortController().signal,
      runId: '26588a79-31ff-47b4-8c11-516fcbfb3f6f',
      attempt: 1,
      approvedToolNames: new Set(),
    };
    await runtime.run(task, context, 'api_agent');
    const second = await runtime.run(task, context, 'api_agent');

    expect(breaker.snapshot('api_agent').state).toBe('open');
    expect(second.events[0]?.message).toContain('circuit is open');
    expect(second.status).toBe('succeeded');
  });
});
