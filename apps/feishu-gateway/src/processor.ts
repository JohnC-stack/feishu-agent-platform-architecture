import type { FeishuMessageEvent } from './connection.js';
import { parseFeishuMessage, type ParsedFeishuMessage } from './message.js';
import type { MessagePipelineConfig } from './pipeline-config.js';
import type { ReplyDispatcher } from './reply.js';
import type { IdempotencyStore, RateLimiter } from './stores.js';

export type MessageProcessingStatus =
  'replied' | 'duplicate' | 'rate_limited' | 'ignored_bot_message';

export interface MessageProcessorOptions {
  config: MessagePipelineConfig;
  idempotency: IdempotencyStore;
  rateLimiter: RateLimiter;
  replies: ReplyDispatcher;
  createResponse?(message: ParsedFeishuMessage): string | Promise<string>;
}

export interface MessageProcessorSnapshot {
  total: number;
  replied: number;
  duplicate: number;
  rateLimited: number;
  ignoredBotMessage: number;
  failed: number;
  lastProcessedAt?: string;
}

export class FeishuMessageProcessor {
  private readonly counters: Omit<MessageProcessorSnapshot, 'lastProcessedAt'> = {
    total: 0,
    replied: 0,
    duplicate: 0,
    rateLimited: 0,
    ignoredBotMessage: 0,
    failed: 0,
  };
  private lastProcessedAt?: string;

  public constructor(private readonly options: MessageProcessorOptions) {}

  public async process(event: FeishuMessageEvent): Promise<MessageProcessingStatus> {
    this.counters.total += 1;
    if (event.sender.sender_type === 'app') {
      return this.record('ignored_bot_message');
    }

    const message = parseFeishuMessage(event);
    const lease = await this.options.idempotency.begin(
      'event',
      message.eventId,
      this.options.config.eventLeaseSeconds,
    );
    if (!lease) {
      return this.record('duplicate');
    }

    try {
      const rate = await this.options.rateLimiter.consume(
        `${message.senderId}:${message.chatId}`,
        this.options.config.rateLimitMax,
        this.options.config.rateLimitWindowSeconds,
      );
      if (!rate.allowed) {
        await this.options.idempotency.complete(lease, this.options.config.eventDedupTtlSeconds);
        return this.record('rate_limited');
      }

      const response = await (this.options.createResponse ?? createPocResponse)(message);
      await this.options.replies.replyText(message, response);
      await this.options.idempotency.complete(lease, this.options.config.eventDedupTtlSeconds);
      return this.record('replied');
    } catch (error: unknown) {
      this.counters.failed += 1;
      this.lastProcessedAt = new Date().toISOString();
      await this.options.idempotency.release(lease);
      throw error;
    }
  }

  public getSnapshot(): MessageProcessorSnapshot {
    return {
      ...this.counters,
      ...(this.lastProcessedAt ? { lastProcessedAt: this.lastProcessedAt } : {}),
    };
  }

  private record(status: MessageProcessingStatus): MessageProcessingStatus {
    const counter: Record<MessageProcessingStatus, keyof typeof this.counters> = {
      replied: 'replied',
      duplicate: 'duplicate',
      rate_limited: 'rateLimited',
      ignored_bot_message: 'ignoredBotMessage',
    };
    this.counters[counter[status]] += 1;
    this.lastProcessedAt = new Date().toISOString();
    return status;
  }
}

function createPocResponse(message: ParsedFeishuMessage): string {
  const command = message.text.split(/\s+/, 1)[0]?.toLowerCase();
  if (command === '/ping') {
    return 'pong';
  }
  if (command === '/health') {
    return '飞书 WSS 接入、事件去重和回复调度运行正常。';
  }
  if (message.attachments.length > 0) {
    return `已收到 ${message.attachments.length} 个附件，当前 PoC 仅记录附件元数据。`;
  }
  return '消息已收到，飞书接入 PoC 运行正常。';
}
