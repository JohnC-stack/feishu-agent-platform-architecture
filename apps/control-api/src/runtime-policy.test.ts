import { describe, expect, it } from 'vitest';

import type { TaskRequest } from '@feishu-agent/contracts';
import { RuleRouter } from '@feishu-agent/policy';

import { approvedToolsFor, defaultRouteRules } from './runtime.js';

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-p4-policy',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: '/gitlab project team/project', command: '/gitlab', attachments: [] },
  requestedExecutor: 'direct_tool',
  riskLevel: 'low',
  correlationId: 'trace-p4-policy',
  createdAt: '2026-08-21T00:00:00.000Z',
  metadata: {},
};

describe('P4 enterprise tool routing policy', () => {
  it.each([
    ['/gitlab', 'gitlab.read'],
    ['/confluence', 'confluence.read'],
    ['/feishu', 'feishu.read'],
  ])('routes and approves only the matching read tool for %s', (command, toolName) => {
    const router = new RuleRouter(defaultRouteRules, 'agent_cli');
    const routed = router.route({
      chatType: 'group',
      command,
      text: `${command} test`,
      riskLevel: 'low',
      attachmentCount: 0,
    });
    const requested = {
      ...task,
      input: { ...task.input, text: `${command} test`, command },
    };

    expect(routed).toMatchObject({ executor: 'direct_tool', ruleId: 'enterprise-read-direct' });
    expect(approvedToolsFor(requested)).toEqual([toolName]);
  });

  it('does not approve enterprise tools for Agent CLI tasks', () => {
    expect(approvedToolsFor({ ...task, requestedExecutor: 'agent_cli' })).toEqual([]);
  });
});
