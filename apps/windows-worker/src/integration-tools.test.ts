import { describe, expect, it } from 'vitest';

import type { TaskRequest } from '@feishu-agent/contracts';
import { ToolGateway } from '@feishu-agent/executors';

import {
  createEnterpriseIntegrationRuntime,
  parseConfluenceCommand,
  parseFeishuCommand,
  parseGitLabCommand,
} from './integration-tools.js';

const baseTask: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-p4',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: '', attachments: [] },
  riskLevel: 'low',
  correlationId: 'trace-p4',
  createdAt: '2026-08-21T00:00:00.000Z',
  metadata: {},
};

describe('enterprise integration tool runtime', () => {
  it('remains ready but fail-closed when credentials or resource allowlists are absent', async () => {
    const integrations = createEnterpriseIntegrationRuntime({});
    const gateway = new ToolGateway(integrations.tools);

    expect(integrations.status).toEqual({ gitlab: false, confluence: false, feishu: false });
    await expect(
      gateway.invoke(
        'gitlab.read',
        { action: 'project', project: 'team/project' },
        new Set(['gitlab.read']),
        { task: baseTask, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      category: 'dependency',
      code: 'GITLAB_INTEGRATION_NOT_CONFIGURED',
      retryable: false,
    });
  });

  it('parses deterministic commands without invoking a model', () => {
    expect(
      parseGitLabCommand({
        ...baseTask,
        input: { text: '/gitlab diffs team/project 17 2 50', attachments: [] },
      }),
    ).toEqual({ action: 'diffs', project: 'team/project', iid: 17, page: 2, perPage: 50 });
    expect(
      parseConfluenceCommand({
        ...baseTask,
        input: { text: '/confluence search ENG "release risk"', attachments: [] },
      }),
    ).toEqual({ action: 'search', spaceKey: 'ENG', text: 'release risk' });
    expect(
      parseFeishuCommand({
        ...baseTask,
        input: { text: '/feishu document doc-1', attachments: [] },
      }),
    ).toEqual({ action: 'document', documentId: 'doc-1' });
  });
});
