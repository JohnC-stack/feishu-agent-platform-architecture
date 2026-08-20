import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createWindowsWorker } from './app.js';

describe('windows-worker', () => {
  it('uses the shared service health response', async () => {
    const app = createWindowsWorker();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'windows-worker', status: 'ok' });
  });

  it('removes the API Agent from active capabilities when the channel is disabled', async () => {
    vi.stubEnv('API_AGENT_ENABLED', 'false');
    const app = createWindowsWorker();
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      const taskId = randomUUID();
      const disabledExecution = await app.inject({
        method: 'POST',
        url: '/v1/executions',
        payload: {
          task: {
            id: taskId,
            source: {
              channel: 'feishu',
              eventId: `event-${taskId}`,
              chatId: 'chat-1',
              userId: 'user-1',
              replyTargetId: 'message-1',
            },
            input: { text: 'Analyze platform health', attachments: [] },
            riskLevel: 'low',
            correlationId: `trace-${taskId}`,
            createdAt: new Date().toISOString(),
            metadata: {},
          },
          executor: 'api_agent',
          runId: randomUUID(),
          attempt: 1,
          approvedToolNames: ['platform.health'],
        },
      });

      expect(root.json()).toMatchObject({
        executors: ['direct_tool', 'agent_cli'],
        capabilities: { apiAgentEnabled: false, apiAgentConfigured: false },
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json<{ checks: Array<{ name: string }> }>().checks).not.toContainEqual(
        expect.objectContaining({ name: 'api_agent' }),
      );
      expect(disabledExecution.json()).toMatchObject({
        executor: 'api_agent',
        status: 'failed',
        failure: { code: 'API_AGENT_DISABLED', retryable: false },
      });
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it('executes a direct route end to end without a model', async () => {
    const app = createWindowsWorker();
    const taskId = randomUUID();
    const runId = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/executions',
      payload: {
        task: {
          id: taskId,
          source: {
            channel: 'feishu',
            eventId: `event-${taskId}`,
            chatId: 'chat-1',
            userId: 'user-1',
            replyTargetId: 'message-1',
          },
          input: { text: '/ping', command: '/ping', attachments: [] },
          riskLevel: 'low',
          correlationId: `trace-${taskId}`,
          createdAt: new Date().toISOString(),
          metadata: {},
        },
        executor: 'direct_tool',
        runId,
        attempt: 1,
        approvedToolNames: ['platform.ping'],
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskId,
      runId,
      executor: 'direct_tool',
      status: 'succeeded',
    });
    const result = response.json<{ events: Array<{ payload: Record<string, unknown> }> }>();
    expect(result.events.at(-1)?.payload).toMatchObject({ modelCalled: false });
  });
});
