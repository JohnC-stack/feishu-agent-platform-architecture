import { describe, expect, it } from 'vitest';

import {
  RuleRouter,
  allowedTransitions,
  assertTransition,
  canTransition,
  createTaskTransition,
  requiresApproval,
  terminalTaskStatuses,
} from './index.js';

describe('task state transitions', () => {
  it('allows approval to pause and resume a running task', () => {
    expect(canTransition('running', 'waiting_approval')).toBe(true);
    expect(canTransition('waiting_approval', 'running')).toBe(true);
  });

  it('does not allow terminal tasks to restart', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow(
      'Invalid task transition: succeeded -> running',
    );
    expect(terminalTaskStatuses.has('succeeded')).toBe(true);
    expect(allowedTransitions('succeeded')).toEqual([]);
  });

  it('creates a validated and timestamped transition record', () => {
    expect(
      createTaskTransition({
        taskId: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
        from: 'queued',
        to: 'running',
        occurredAt: '2026-08-20T00:00:01.000Z',
      }),
    ).toMatchObject({ from: 'queued', to: 'running' });
  });
});

describe('versioned rule router', () => {
  it('uses priority and records the matched rule version', () => {
    const router = new RuleRouter([
      {
        id: 'attachment-cli',
        version: 3,
        priority: 50,
        enabled: true,
        condition: { hasAttachments: true },
        executor: 'agent_cli',
      },
      {
        id: 'health-direct',
        version: 2,
        priority: 100,
        enabled: true,
        condition: { commands: ['/health'] },
        executor: 'direct_tool',
      },
    ]);

    expect(
      router.route({
        chatType: 'group',
        command: '/health',
        text: '/health',
        riskLevel: 'low',
        attachmentCount: 1,
      }),
    ).toMatchObject({ executor: 'direct_tool', ruleId: 'health-direct', ruleVersion: 2 });
  });

  it('falls back deterministically when no rule matches', () => {
    const router = new RuleRouter([]);
    expect(
      router.route({
        chatType: 'p2p',
        text: 'summarize this',
        riskLevel: 'low',
        attachmentCount: 0,
      }),
    ).toMatchObject({ executor: 'api_agent', ruleId: 'fallback', ruleVersion: 1 });
  });
});

describe('operation approval policy', () => {
  it('requires approval for high-risk writes only', () => {
    expect(requiresApproval({ operation: 'write', riskLevel: 'high' })).toBe(true);
    expect(requiresApproval({ operation: 'read', riskLevel: 'critical' })).toBe(false);
    expect(requiresApproval({ operation: 'write', riskLevel: 'low' })).toBe(false);
  });
});
