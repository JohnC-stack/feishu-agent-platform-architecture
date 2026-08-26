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
  }, 10_000);

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
      const integrations = await app.inject({ method: 'GET', url: '/v1/integrations/status' });
      expect(integrations.statusCode).toBe(200);
      expect(integrations.json()).toMatchObject({
        service: 'windows-worker',
        integrations: expect.arrayContaining([
          { id: 'gitlab', configured: false, resourceCount: 0 },
          { id: 'confluence', configured: false, resourceCount: 0 },
        ]),
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

  it('executes an approved GitLab read command end to end without a model', async () => {
    vi.stubEnv('GITLAB_BASE_URL', 'https://gitlab.example');
    vi.stubEnv('GITLAB_TOKEN', 'read-only-token');
    vi.stubEnv('GITLAB_ALLOWED_PROJECTS', 'team/project');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: 7, path_with_namespace: 'team/project' }), {
          status: 200,
        }),
      ),
    );
    const app = createWindowsWorker();
    const taskId = randomUUID();
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
          input: {
            text: '/gitlab project team/project',
            command: '/gitlab',
            attachments: [],
          },
          riskLevel: 'low',
          correlationId: `trace-${taskId}`,
          createdAt: new Date().toISOString(),
          metadata: {},
        },
        executor: 'direct_tool',
        runId: randomUUID(),
        attempt: 1,
        approvedToolNames: ['gitlab.read'],
      },
    });

    try {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        taskId,
        executor: 'direct_tool',
        status: 'succeeded',
      });
      expect(response.body).toContain('team/project');
      expect(response.body).not.toContain('read-only-token');
    } finally {
      await app.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
