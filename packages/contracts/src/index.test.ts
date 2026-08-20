import { describe, expect, it } from 'vitest';

import {
  ExecutorEventSchema,
  RouteRuleSchema,
  TaskRequestSchema,
  TaskTransitionSchema,
} from './index.js';

const taskId = 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f';

describe('TaskRequestSchema', () => {
  it('applies safe defaults to an inbound Feishu task', () => {
    const task = TaskRequestSchema.parse({
      id: taskId,
      source: {
        channel: 'feishu',
        eventId: 'event-1',
        chatId: 'chat-1',
        userId: 'user-1',
        replyTargetId: 'message-1',
      },
      input: { text: '/health' },
      correlationId: 'trace-1',
      createdAt: '2026-08-20T00:00:00.000Z',
    });

    expect(task.input.attachments).toEqual([]);
    expect(task.riskLevel).toBe('low');
    expect(task.metadata).toEqual({});
  });
});

describe('ExecutorEventSchema', () => {
  it('rejects events without an ordered sequence', () => {
    const result = ExecutorEventSchema.safeParse({
      taskId,
      sequence: -1,
      kind: 'started',
      createdAt: '2026-08-20T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});

describe('P2 scheduling contracts', () => {
  it('validates an auditable task transition', () => {
    expect(
      TaskTransitionSchema.parse({
        taskId,
        from: 'queued',
        to: 'running',
        occurredAt: '2026-08-20T00:00:01.000Z',
      }),
    ).toMatchObject({ from: 'queued', to: 'running' });
  });

  it('requires every routing rule to carry a positive version', () => {
    const result = RouteRuleSchema.safeParse({
      id: 'health-direct',
      version: 0,
      priority: 100,
      condition: { commands: ['/health'] },
      executor: 'direct_tool',
    });

    expect(result.success).toBe(false);
  });
});
