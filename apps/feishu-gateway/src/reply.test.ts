import { describe, expect, it } from 'vitest';

import type { ParsedFeishuMessage } from './message.js';
import { ReplyDispatcher, type FeishuReplyClient } from './reply.js';
import { InMemoryIdempotencyStore } from './stores.js';

const message: ParsedFeishuMessage = {
  eventId: 'event-1',
  messageId: 'message-1',
  chatId: 'chat-1',
  chatType: 'p2p',
  senderId: 'user-1',
  senderType: 'user',
  messageType: 'text',
  text: 'hello',
  attachments: [],
  receivedAt: '2026-08-20T00:00:00.000Z',
};

describe('ReplyDispatcher', () => {
  it('retries a Feishu OpenAPI rate-limit response with the same deterministic UUID', async () => {
    const requests: { uuid: string }[] = [];
    const client: FeishuReplyClient = {
      reply(request) {
        requests.push({ uuid: request.uuid });
        return Promise.resolve(requests.length === 1 ? { code: 99991400 } : { code: 0 });
      },
    };
    const dispatcher = new ReplyDispatcher({
      client,
      idempotency: new InMemoryIdempotencyStore(),
      leaseSeconds: 60,
      completionTtlSeconds: 3600,
      chunkCharacters: 4000,
      maxAttempts: 3,
      retryBaseDelayMs: 1,
    });

    await expect(dispatcher.replyText(message, 'pong')).resolves.toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.uuid).toBe(requests[1]?.uuid);
  });

  it('splits long messages and keeps a completed reply idempotent', async () => {
    const requests: string[] = [];
    const idempotency = new InMemoryIdempotencyStore();
    const dispatcher = new ReplyDispatcher({
      client: {
        reply(request) {
          requests.push(request.content);
          return Promise.resolve({ code: 0 });
        },
      },
      idempotency,
      leaseSeconds: 60,
      completionTtlSeconds: 3600,
      chunkCharacters: 5,
    });

    await expect(dispatcher.replyText(message, 'abcdefghij')).resolves.toBe(2);
    await expect(dispatcher.replyText(message, 'abcdefghij')).resolves.toBe(0);
    expect(requests).toHaveLength(2);
  });
});
