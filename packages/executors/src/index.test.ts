import { describe, expect, it } from 'vitest';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { NoopExecutor } from './index.js';

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-1',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: '/health', attachments: [] },
  riskLevel: 'low',
  correlationId: 'trace-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  metadata: {},
};

describe('NoopExecutor', () => {
  it('uses the shared ordered event protocol', async () => {
    const executor = new NoopExecutor('direct_tool');
    const events: ExecutorEvent[] = [];

    for await (const event of executor.execute(task, {
      signal: new AbortController().signal,
      approvedToolNames: new Set(),
    })) {
      events.push(event);
    }

    expect(events.map(({ kind }) => kind)).toEqual(['started', 'completed']);
    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1]);
  });
});
