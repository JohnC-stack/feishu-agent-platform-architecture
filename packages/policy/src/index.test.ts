import { describe, expect, it } from 'vitest';

import {
  RbacPolicy,
  RuleRouter,
  allowedTransitions,
  assertApprovalActor,
  assertTransition,
  canTransition,
  createTaskTransition,
  defaultGovernanceRoles,
  evaluateBudget,
  nextApprovalStatus,
  redactAuditDetails,
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

describe('P5 governance policy', () => {
  const policy = new RbacPolicy(defaultGovernanceRoles, [
    { principalType: 'user', principalId: 'reader-1', roleId: 'reader' },
    { principalType: 'group', principalId: 'operators', roleId: 'operator' },
    { principalType: 'user', principalId: 'approver-1', roleId: 'approver' },
  ]);

  it('hides tools that are not granted to a principal', () => {
    expect(
      policy.visibleTools({
        userId: 'reader-1',
        toolNames: ['platform.health', 'gitlab.read', 'agent_cli.execute'],
      }),
    ).toEqual(['platform.health', 'gitlab.read']);
    expect(policy.authorizeTool({ userId: 'unknown', toolName: 'platform.health' }).allowed).toBe(
      false,
    );
  });

  it('combines user and group role bindings without granting unrelated actions', () => {
    expect(
      policy.authorizeTool({
        userId: 'reader-1',
        groupIds: ['operators'],
        toolName: 'agent_cli.execute',
        resourceType: 'workspace',
        resourceId: 'D:/Codex/coding',
      }).allowed,
    ).toBe(true);
    expect(policy.authorizeAction({ userId: 'reader-1', action: 'approval.decide' }).allowed).toBe(
      false,
    );
    expect(
      policy.authorizeAction({ userId: 'approver-1', action: 'approval.decide' }).allowed,
    ).toBe(true);
  });

  it('enforces terminal approval decisions and separation of duties', () => {
    expect(nextApprovalStatus('pending', 'approve')).toBe('approved');
    expect(nextApprovalStatus('approved', 'revoke')).toBe('revoked');
    expect(() => nextApprovalStatus('rejected', 'approve')).toThrow('cannot transition');
    expect(() => assertApprovalActor({ requestedBy: 'user-1', decidedBy: 'user-1' })).toThrow(
      'cannot approve',
    );
  });

  it('checks token and cost budgets across every supplied scope', () => {
    const result = evaluateBudget({
      limits: [
        {
          scopeType: 'user',
          scopeId: 'reader-1',
          period: 'day',
          tokenLimit: 1_000,
          costLimitMicros: 500,
        },
        {
          scopeType: 'model',
          scopeId: 'gpt-test',
          period: 'day',
          tokenLimit: 10_000,
          costLimitMicros: 10_000,
        },
      ],
      usage: [
        {
          scopeType: 'user',
          scopeId: 'reader-1',
          period: 'day',
          tokensUsed: 900,
          costMicrosUsed: 100,
        },
      ],
      proposedTokens: 200,
      proposedCostMicros: 50,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      {
        scopeType: 'user',
        scopeId: 'reader-1',
        dimension: 'tokens',
        limit: 1_000,
        projected: 1_100,
      },
    ]);
  });

  it('redacts nested credentials and token-shaped strings from audit details', () => {
    expect(
      redactAuditDetails({
        authorization: 'Bearer live-value',
        nested: {
          appSecret: 'do-not-store',
          trace: `PRIVATE-TOKEN: ${['glpat', 'fixture', 'value'].join('-')}`,
        },
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      nested: { appSecret: '[REDACTED]', trace: 'PRIVATE-TOKEN: [REDACTED]' },
    });
  });
});
