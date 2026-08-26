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
    expect(integrations.resourceCounts).toEqual({ gitlab: 0, confluence: 0, feishu: 0 });
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

  it('reports only redacted integration readiness and resource counts', () => {
    const integrations = createEnterpriseIntegrationRuntime({
      GITLAB_ALLOWED_PROJECTS: 'team/a,team/b,team/a',
      CONFLUENCE_ALLOWED_SPACE_KEYS: 'ENG,OPS',
      CONFLUENCE_ALLOWED_PAGE_IDS: '100,200',
      FEISHU_ALLOWED_DOCUMENT_IDS: 'doc-1',
      FEISHU_ALLOWED_CHAT_IDS: 'chat-1',
    });

    expect(integrations.resourceCounts).toEqual({ gitlab: 2, confluence: 4, feishu: 2 });
    expect(JSON.stringify(integrations.resourceCounts)).not.toContain('team/a');
  });

  it('configures the service-safe Confluence runner without a user-profile CLI', () => {
    const integrations = createEnterpriseIntegrationRuntime({
      CONFLUENCE_BASE_URL: 'http://confluence.internal/confluence',
      CONFLUENCE_USERNAME: 'service-user',
      CONFLUENCE_PASSWORD: 'resolved-at-startup',
      CONFLUENCE_ALLOWED_SPACE_KEYS: 'ENG',
      CONFLUENCE_ALLOWED_PAGE_IDS: '100',
    });

    expect(integrations.status.confluence).toBe(true);
    expect(integrations.resourceCounts.confluence).toBe(2);
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
