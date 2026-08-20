import { createHash } from 'node:crypto';

import { Client, Domain } from '@larksuiteoapi/node-sdk';

import type { FeishuGatewayConfig } from './config.js';
import type { ParsedFeishuMessage } from './message.js';
import type { IdempotencyStore } from './stores.js';

export interface ReplyRequest {
  messageId: string;
  content: string;
  uuid: string;
  replyInThread: boolean;
}

export interface ReplyResult {
  code?: number;
  message?: string;
  messageId?: string;
}

export interface FeishuReplyClient {
  reply(request: ReplyRequest): Promise<ReplyResult>;
}

export interface ReplyDispatcherOptions {
  client: FeishuReplyClient;
  idempotency: IdempotencyStore;
  leaseSeconds: number;
  completionTtlSeconds: number;
  chunkCharacters: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

export class ReplyDispatcher {
  public constructor(private readonly options: ReplyDispatcherOptions) {}

  public async replyText(message: ParsedFeishuMessage, text: string): Promise<number> {
    const chunks = splitText(text, this.options.chunkCharacters);
    let sent = 0;

    for (const [index, chunk] of chunks.entries()) {
      const idempotencyKey = `${message.eventId}:${index}`;
      const lease = await this.options.idempotency.begin(
        'reply',
        idempotencyKey,
        this.options.leaseSeconds,
      );
      if (!lease) {
        continue;
      }

      try {
        await this.sendWithRetry({
          messageId: message.messageId,
          content: JSON.stringify({ text: chunk }),
          uuid: deterministicUuid(idempotencyKey),
          replyInThread: Boolean(message.threadId),
        });
        await this.options.idempotency.complete(lease, this.options.completionTtlSeconds);
        sent += 1;
      } catch (error: unknown) {
        await this.options.idempotency.release(lease);
        throw error;
      }
    }

    return sent;
  }

  private async sendWithRetry(request: ReplyRequest): Promise<void> {
    const maximumAttempts = this.options.maxAttempts ?? 3;
    const baseDelayMs = this.options.retryBaseDelayMs ?? 250;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const result = await this.options.client.reply(request);
        if ((result.code ?? 0) === 0) {
          return;
        }
        if (!isRetryableCode(result.code) || attempt === maximumAttempts) {
          throw new Error(`Feishu reply failed with code ${result.code}: ${result.message ?? ''}`);
        }
      } catch (error: unknown) {
        if (attempt === maximumAttempts || !isRetryableError(error)) {
          throw error;
        }
      }
      await delay(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

function isRetryableCode(code: number | undefined): boolean {
  return code === 429 || code === 99991400 || (code !== undefined && code >= 500);
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as {
    code?: string | number;
    status?: number;
    response?: { status?: number; data?: { code?: number } };
  };
  return (
    record.status === 429 ||
    record.response?.status === 429 ||
    record.response?.status === 500 ||
    record.response?.status === 502 ||
    record.response?.status === 503 ||
    record.response?.status === 504 ||
    record.response?.data?.code === 99991400 ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(record.code))
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createSdkReplyClient(config: FeishuGatewayConfig): FeishuReplyClient {
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu credentials are required to create a reply client.');
  }
  const client = new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Domain.Feishu,
  });

  return {
    async reply(request) {
      const response = await client.im.v1.message.reply({
        path: { message_id: request.messageId },
        data: {
          msg_type: 'text',
          content: request.content,
          uuid: request.uuid,
          reply_in_thread: request.replyInThread,
        },
      });
      return {
        code: response.code,
        message: response.msg,
        messageId: response.data?.message_id,
      };
    },
  };
}

function splitText(text: string, maximumCharacters: number): string[] {
  if (text.length <= maximumCharacters) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maximumCharacters) {
    let splitAt = remaining.lastIndexOf('\n', maximumCharacters);
    if (splitAt <= 0) {
      splitAt = maximumCharacters;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
