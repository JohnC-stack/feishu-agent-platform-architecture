import { Client, Domain } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';

import type { FeishuGatewayConfig } from './config.js';
import type { FeishuCardActionEvent } from './connection.js';
import type { IdempotencyStore } from './stores.js';

const ApprovalActionValueSchema = z
  .object({
    approvalId: z.string().uuid(),
    action: z.enum(['approve', 'reject', 'revoke']),
  })
  .strict();

export interface ApprovalDecisionClient {
  decide(input: {
    approvalId: string;
    actorId: string;
    groupIds: string[];
    action: 'approve' | 'reject' | 'revoke';
  }): Promise<ApprovalDecisionResult>;
}

export interface ApprovalDecisionResult {
  approval: {
    status: string;
    requestedBy: string;
    expiresAt: string;
    decidedBy?: string;
  };
  operation: {
    status: string;
    toolName: string;
    riskLevel: string;
    resourceType: string;
    resourceId: string;
  };
}

export interface ApprovalCardClient {
  send(chatId: string, card: Record<string, unknown>): Promise<{ messageId: string }>;
  update(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export interface ApprovalProcessorSnapshot {
  total: number;
  approved: number;
  rejected: number;
  revoked: number;
  duplicate: number;
  failed: number;
  cardRefreshScheduled: number;
  cardRefreshFailed: number;
  lastProcessedAt?: string;
}

export interface ApprovalCardActionResult {
  disposition: 'processed' | 'duplicate';
  card: Record<string, unknown>;
}

export class ApprovalCardActionProcessor {
  private readonly counters: Omit<ApprovalProcessorSnapshot, 'lastProcessedAt'> = {
    total: 0,
    approved: 0,
    rejected: 0,
    revoked: 0,
    duplicate: 0,
    failed: 0,
    cardRefreshScheduled: 0,
    cardRefreshFailed: 0,
  };
  private lastProcessedAt?: string;

  public constructor(
    private readonly options: {
      decisions: ApprovalDecisionClient;
      cards: ApprovalCardClient;
      idempotency: IdempotencyStore;
      leaseSeconds: number;
      completionTtlSeconds: number;
      scheduleCardRefresh?(task: () => Promise<void>): void;
    },
  ) {}

  public async process(event: FeishuCardActionEvent): Promise<ApprovalCardActionResult> {
    this.counters.total += 1;
    const parsed = parseCardAction(event);
    const key = `${parsed.messageId}:${parsed.approvalId}`;
    const completedCard = await this.readCompletedCard(key);
    if (completedCard) {
      return this.duplicate(completedCard);
    }
    const lease = await this.options.idempotency.begin(
      'approval-action',
      key,
      this.options.leaseSeconds,
    );
    if (!lease) {
      const duplicateCard = await this.waitForCompletedCard(key);
      if (!duplicateCard) {
        throw new Error('Approval action is already being processed and has no terminal card yet.');
      }
      return this.duplicate(duplicateCard);
    }
    try {
      const result = await this.options.decisions.decide({
        approvalId: parsed.approvalId,
        actorId: parsed.actorId,
        groupIds: [parsed.chatId],
        action: parsed.action,
      });
      const card = buildDecisionCard({ action: parsed.action, ...result });
      this.counters[decisionCounter(parsed.action)] += 1;
      this.lastProcessedAt = new Date().toISOString();
      const completed = await this.options.idempotency.complete(
        lease,
        this.options.completionTtlSeconds,
        JSON.stringify(card),
      );
      if (!completed) {
        throw new Error(
          'Approval action completion lease was lost before the terminal card was saved.',
        );
      }
      this.scheduleCardRefresh(parsed.messageId, card);
      return { disposition: 'processed', card };
    } catch (error: unknown) {
      this.counters.failed += 1;
      this.lastProcessedAt = new Date().toISOString();
      await this.options.idempotency.release(lease);
      throw error;
    }
  }

  private duplicate(card: Record<string, unknown>): ApprovalCardActionResult {
    this.counters.duplicate += 1;
    this.lastProcessedAt = new Date().toISOString();
    return { disposition: 'duplicate', card };
  }

  private async readCompletedCard(key: string): Promise<Record<string, unknown> | undefined> {
    const value = await this.options.idempotency.getCompletion('approval-action', key);
    if (!value) return undefined;
    const card = JSON.parse(value) as unknown;
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('Stored approval terminal card is invalid.');
    }
    return card as Record<string, unknown>;
  }

  private async waitForCompletedCard(key: string): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const card = await this.readCompletedCard(key);
      if (card) return card;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  private scheduleCardRefresh(messageId: string, card: Record<string, unknown>): void {
    this.counters.cardRefreshScheduled += 1;
    const refresh = async (): Promise<void> => {
      try {
        await this.options.cards.update(messageId, card);
      } catch {
        this.counters.cardRefreshFailed += 1;
      }
    };
    if (this.options.scheduleCardRefresh) {
      this.options.scheduleCardRefresh(refresh);
      return;
    }
    const timer = setTimeout(() => void refresh(), 250);
    timer.unref();
  }

  public getSnapshot(): ApprovalProcessorSnapshot {
    return {
      ...this.counters,
      ...(this.lastProcessedAt ? { lastProcessedAt: this.lastProcessedAt } : {}),
    };
  }
}

export function createControlApiApprovalClient(
  baseUrlInput = process.env.CONTROL_API_INTERNAL_URL ?? 'http://127.0.0.1:3000',
): ApprovalDecisionClient {
  const baseUrl = new URL(baseUrlInput);
  if (!['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) {
    throw new Error('CONTROL_API_INTERNAL_URL must resolve to the local loopback interface.');
  }
  return {
    async decide(input) {
      const response = await fetch(
        new URL(
          `/v1/governance/approvals/${encodeURIComponent(input.approvalId)}/decisions`,
          baseUrl,
        ),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actorId: input.actorId,
            groupIds: input.groupIds,
            action: input.action,
          }),
          signal: AbortSignal.timeout(2_500),
        },
      );
      const body = (await response.json()) as unknown;
      if (!response.ok) {
        const errorValue =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error?: unknown }).error
            : undefined;
        const error = typeof errorValue === 'string' ? errorValue : '';
        throw new Error(`Control API approval decision failed: ${response.status}/${error}`);
      }
      return ApprovalDecisionResultSchema.parse(body);
    },
  };
}

export function createSdkApprovalCardClient(config: FeishuGatewayConfig): ApprovalCardClient {
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu credentials are required to create an approval card client.');
  }
  const client = new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Domain.Feishu,
  });
  return {
    async send(chatId, card) {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      if ((response.code ?? 0) !== 0 || !response.data?.message_id) {
        throw new Error(`Feishu approval card send failed: ${response.code}/${response.msg ?? ''}`);
      }
      return { messageId: response.data.message_id };
    },
    async update(messageId, card) {
      const response = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if ((response.code ?? 0) !== 0) {
        throw new Error(
          `Feishu approval card update failed: ${response.code}/${response.msg ?? ''}`,
        );
      }
    },
  };
}

function parseCardAction(event: FeishuCardActionEvent): {
  approvalId: string;
  action: 'approve' | 'reject' | 'revoke';
  actorId: string;
  chatId: string;
  messageId: string;
} {
  const raw = event;
  const action = ApprovalActionValueSchema.parse(raw.action?.value);
  const actorId = raw.operator?.open_id ?? raw.operator?.user_id;
  const chatId = raw.context?.open_chat_id ?? raw.open_chat_id;
  const messageId = raw.context?.open_message_id ?? raw.open_message_id;
  if (!actorId || !chatId || !messageId) {
    throw new Error(
      'Feishu approval card callback is missing actor, chat, or message identifiers.',
    );
  }
  return { ...action, actorId, chatId, messageId };
}

function decisionCounter(action: 'approve' | 'reject' | 'revoke') {
  const counters = { approve: 'approved', reject: 'rejected', revoke: 'revoked' } as const;
  return counters[action];
}

const ApprovalDecisionResultSchema = z.object({
  approval: z.object({
    status: z.string().min(1),
    requestedBy: z.string().min(1),
    expiresAt: z.string().min(1),
    decidedBy: z.string().min(1).optional(),
  }),
  operation: z.object({
    status: z.string().min(1),
    toolName: z.string().min(1),
    riskLevel: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
  }),
});

function buildDecisionCard(
  input: ApprovalDecisionResult & {
    action: 'approve' | 'reject' | 'revoke';
  },
): Record<string, unknown> {
  const labels = { approve: '已批准', reject: '已拒绝', revoke: '已撤销' };
  const approvalStatus = localizeApprovalStatus(input.approval.status);
  const operationStatus = localizeOperationStatus(input.operation.status);
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: input.action === 'approve' ? 'green' : 'grey',
      title: { tag: 'plain_text', content: `审批${labels[input.action]}` },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**工具：** ${input.operation.toolName}`,
          `**资源：** ${input.operation.resourceType}/${input.operation.resourceId}`,
          `**风险：** ${input.operation.riskLevel}`,
          `**申请人：** ${input.approval.requestedBy}`,
          `**过期时间：** ${formatFeishuDateTime(input.approval.expiresAt)}`,
        ].join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: [
          `**审批状态：** ${approvalStatus}`,
          `**操作状态：** ${operationStatus}`,
          ...(input.approval.decidedBy ? [`**审批人：** ${input.approval.decidedBy}`] : []),
        ].join('\n'),
      },
    ],
  };
}

function localizeApprovalStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: '待审批',
    approved: '已批准',
    rejected: '已拒绝',
    expired: '已过期',
    revoked: '已撤销',
  };
  return labels[status] ?? `未知状态（${status}）`;
}

function formatFeishuDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const [year, month, day, hour, minute, second] = [
    read('year'),
    read('month'),
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  ];
  return year && month && day && hour && minute && second
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}`
    : value;
}

function localizeOperationStatus(status: string): string {
  const labels: Record<string, string> = {
    pending_approval: '待审批',
    approved: '已批准（等待执行）',
    executing: '执行中',
    succeeded: '执行成功',
    failed: '执行失败',
    rejected: '已拒绝',
    expired: '已过期',
    revoked: '已撤销',
  };
  return labels[status] ?? `未知状态（${status}）`;
}
