import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TaskRequest } from '@feishu-agent/contracts';
import { ExecutorRuntime, NoopExecutor, TaskWorkspaceManager } from '@feishu-agent/executors';

import { WindowsExecutionService } from './execution-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('WindowsExecutionService', () => {
  it('refuses to run a high-risk Agent CLI task locally when Hyper-V is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-worker-service-'));
    temporaryDirectories.push(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const runtime = new ExecutorRuntime({ executors: [new NoopExecutor('agent_cli')] });
    const service = new WindowsExecutionService({
      runtime,
      workspaceManager: new TaskWorkspaceManager({
        taskRoot: join(root, 'tasks'),
        authorizedWorkspaceRoots: [workspace],
      }),
    });
    const task: TaskRequest = {
      id: '3ac1ce95-b21c-41a4-a7ec-b1afdc1e4639',
      source: {
        channel: 'feishu',
        eventId: 'high-risk-event',
        chatId: 'chat-1',
        userId: 'user-1',
        replyTargetId: 'message-1',
      },
      input: { text: '/agent high-risk task', command: '/agent', attachments: [] },
      requestedExecutor: 'agent_cli',
      riskLevel: 'high',
      correlationId: 'trace-high-risk',
      createdAt: '2026-08-20T00:00:00.000Z',
      metadata: {},
    };
    const result = await service.execute({
      task,
      executor: 'agent_cli',
      runId: 'ca4f8942-de35-4a9d-8e36-1c29fc5e9d1a',
      attempt: 1,
      approvedToolNames: [],
      workspacePath: workspace,
    });

    expect(result.status).toBe('failed');
    expect(result.failure).toMatchObject({
      category: 'sandbox',
      code: 'HYPERV_SANDBOX_UNAVAILABLE',
      retryable: false,
    });
  });
});
