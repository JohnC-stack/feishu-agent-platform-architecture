import { describe, expect, it, vi } from 'vitest';

import type { FeishuCardActionEvent } from './connection.js';
import { ApprovalCardActionProcessor, createControlApiApprovalClient } from './approval.js';
import { InMemoryIdempotencyStore } from './stores.js';

const event = {
  context: {
    open_message_id: 'om_p5_approval',
    open_chat_id: 'oc_p5_approval',
  },
  operator: { open_id: 'ou_p5_approver' },
  action: {
    tag: 'button',
    value: {
      approvalId: '0aeb29c6-541d-4f73-805e-9bf09e2d9f76',
      action: 'approve',
    },
  },
} as unknown as FeishuCardActionEvent;

describe('P5 Feishu approval card actions', () => {
  it('decides a card action once and replaces the shared card with terminal status', async () => {
    const decide = vi.fn(() =>
      Promise.resolve({
        approval: {
          status: 'approved',
          requestedBy: 'ou_requester',
          expiresAt: '2026-08-21T07:28:45.000Z',
          decidedBy: 'ou_p5_approver',
        },
        operation: {
          status: 'approved',
          toolName: 'agent_cli.execute',
          riskLevel: 'critical',
          resourceType: 'workspace',
          resourceId: 'D:/Codex/coding/feishu-agent-platform-architecture',
        },
      }),
    );
    const update = vi.fn<(messageId: string, card: Record<string, unknown>) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const processor = new ApprovalCardActionProcessor({
      decisions: { decide },
      cards: { send: () => Promise.reject(new Error('unused')), update },
      idempotency: new InMemoryIdempotencyStore(),
      leaseSeconds: 60,
      completionTtlSeconds: 86_400,
      scheduleCardRefresh: (task) => void task(),
    });

    const processed = await processor.process(event);
    const duplicate = await processor.process({
      ...event,
      operator: { open_id: 'ou_second_approver' },
      action: {
        tag: 'button',
        value: {
          approvalId: '0aeb29c6-541d-4f73-805e-9bf09e2d9f76',
          action: 'reject',
        },
      },
    });
    expect(processed.disposition).toBe('processed');
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.card).toEqual(processed.card);
    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith({
      approvalId: '0aeb29c6-541d-4f73-805e-9bf09e2d9f76',
      actorId: 'ou_p5_approver',
      groupIds: ['oc_p5_approval'],
      action: 'approve',
    });
    expect(JSON.stringify(update.mock.calls[0]?.[1])).toContain('审批已批准');
    expect(JSON.stringify(processed.card)).toContain('审批已批准');
    expect(JSON.stringify(processed.card)).toContain('agent_cli.execute');
    expect(JSON.stringify(processed.card)).toContain('ou_requester');
    expect(JSON.stringify(processed.card)).toContain('2026-08-21 15:28:45');
    expect(JSON.stringify(processed.card)).not.toContain('2026-08-21T07:28:45.000Z');
    expect(JSON.stringify(processed.card)).toContain('已批准（等待执行）');
    expect(JSON.stringify(processed.card)).not.toContain('"tag":"button"');
    expect(processor.getSnapshot()).toMatchObject({
      total: 2,
      approved: 1,
      rejected: 0,
      duplicate: 1,
      cardRefreshScheduled: 1,
      cardRefreshFailed: 0,
    });
  });

  it('rejects malformed callback values before calling Control API', async () => {
    const decide = vi.fn();
    const processor = new ApprovalCardActionProcessor({
      decisions: { decide },
      cards: {
        send: () => Promise.reject(new Error('unused')),
        update: () => Promise.resolve(),
      },
      idempotency: new InMemoryIdempotencyStore(),
      leaseSeconds: 60,
      completionTtlSeconds: 86_400,
    });
    await expect(
      processor.process({
        ...event,
        action: { value: { approvalId: 'not-a-uuid', action: 'approve' } },
      }),
    ).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses a non-loopback Control API callback destination', () => {
    expect(() => createControlApiApprovalClient('https://example.com')).toThrow('loopback');
  });
});
