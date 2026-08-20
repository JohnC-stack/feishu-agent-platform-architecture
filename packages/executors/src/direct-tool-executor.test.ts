import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { DirectToolExecutor } from './direct-tool-executor.js';
import { ToolGateway } from './tool-gateway.js';

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-1',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: '/ping', command: '/ping', attachments: [] },
  riskLevel: 'low',
  correlationId: 'trace-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  metadata: {},
};

describe('DirectToolExecutor', () => {
  it('executes an approved deterministic tool without a model call', async () => {
    const execute = vi.fn(() => ({ reply: 'pong' }));
    const gateway = new ToolGateway([
      {
        name: 'platform.ping',
        description: 'Return a deterministic health response.',
        operation: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        schema: z.object({}).strict(),
        execute,
      },
    ]);
    const executor = new DirectToolExecutor(gateway, [
      { command: '/ping', toolName: 'platform.ping' },
    ]);
    const events: ExecutorEvent[] = [];
    for await (const event of executor.execute(task, {
      signal: new AbortController().signal,
      runId: '17fd270d-63e4-49b0-8289-646e0c631375',
      attempt: 1,
      approvedToolNames: new Set(['platform.ping']),
    })) {
      events.push(event);
    }

    expect(execute).toHaveBeenCalledOnce();
    expect(events.map(({ kind }) => kind)).toEqual([
      'started',
      'tool_call',
      'tool_result',
      'completed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ modelCalled: false });
  });

  it('blocks tools that were not approved for the task', async () => {
    const gateway = new ToolGateway([
      {
        name: 'platform.ping',
        description: 'Return a deterministic health response.',
        operation: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        schema: z.object({}).strict(),
        execute: () => 'pong',
      },
    ]);
    const executor = new DirectToolExecutor(gateway, [
      { command: '/ping', toolName: 'platform.ping' },
    ]);

    await expect(async () => {
      for await (const event of executor.execute(task, {
        signal: new AbortController().signal,
        runId: '17fd270d-63e4-49b0-8289-646e0c631375',
        attempt: 1,
        approvedToolNames: new Set(),
      })) {
        void event;
        // Consume the stream until the gateway rejects the call.
      }
    }).rejects.toMatchObject({ code: 'TOOL_NOT_APPROVED', category: 'unauthorized' });
  });
});
