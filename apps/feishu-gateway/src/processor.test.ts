import { describe, expect, it } from 'vitest';

import type { FeishuMessageEvent } from './connection.js';
import type { MessagePipelineConfig } from './pipeline-config.js';
import { FeishuMessageProcessor } from './processor.js';
import { ReplyDispatcher, type FeishuReplyClient } from './reply.js';
import { InMemoryIdempotencyStore, InMemoryRateLimiter } from './stores.js';

const config: MessagePipelineConfig = {
  redisUrl: 'redis://test',
  eventLeaseSeconds: 60,
  eventDedupTtlSeconds: 3600,
  rateLimitMax: 1,
  rateLimitWindowSeconds: 60,
  replyChunkCharacters: 4000,
  openApiMaxAttempts: 3,
  openApiRetryBaseMs: 1,
};

function createEvent(eventId: string, messageId = eventId, text = '/ping'): FeishuMessageEvent {
  return {
    event_id: eventId,
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: messageId,
      create_time: '1787220000000',
      chat_id: 'chat-1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

describe('FeishuMessageProcessor', () => {
  it('replies exactly once for duplicate event delivery', async () => {
    const requests: string[] = [];
    const idempotency = new InMemoryIdempotencyStore();
    const client: FeishuReplyClient = {
      reply(request) {
        requests.push(request.messageId);
        return Promise.resolve({ code: 0, messageId: 'reply-1' });
      },
    };
    const processor = new FeishuMessageProcessor({
      config,
      idempotency,
      rateLimiter: new InMemoryRateLimiter(),
      replies: new ReplyDispatcher({
        client,
        idempotency,
        leaseSeconds: config.eventLeaseSeconds,
        completionTtlSeconds: config.eventDedupTtlSeconds,
        chunkCharacters: config.replyChunkCharacters,
      }),
    });

    await expect(processor.process(createEvent('event-1'))).resolves.toBe('replied');
    await expect(processor.process(createEvent('event-1'))).resolves.toBe('duplicate');
    expect(requests).toEqual(['event-1']);
    expect(processor.getSnapshot()).toMatchObject({ total: 2, replied: 1, duplicate: 1 });
  });

  it('limits subsequent events in the same sender and chat window', async () => {
    const idempotency = new InMemoryIdempotencyStore();
    const client: FeishuReplyClient = { reply: () => Promise.resolve({ code: 0 }) };
    const processor = new FeishuMessageProcessor({
      config,
      idempotency,
      rateLimiter: new InMemoryRateLimiter(),
      replies: new ReplyDispatcher({
        client,
        idempotency,
        leaseSeconds: 60,
        completionTtlSeconds: 3600,
        chunkCharacters: 4000,
      }),
    });

    await expect(processor.process(createEvent('event-1'))).resolves.toBe('replied');
    await expect(processor.process(createEvent('event-2'))).resolves.toBe('rate_limited');
  });

  it('routes a health command with trailing arguments to the health response', async () => {
    const responses: string[] = [];
    const idempotency = new InMemoryIdempotencyStore();
    const client: FeishuReplyClient = {
      reply(request) {
        responses.push(JSON.parse(request.content).text as string);
        return Promise.resolve({ code: 0 });
      },
    };
    const processor = new FeishuMessageProcessor({
      config,
      idempotency,
      rateLimiter: new InMemoryRateLimiter(),
      replies: new ReplyDispatcher({
        client,
        idempotency,
        leaseSeconds: 60,
        completionTtlSeconds: 3600,
        chunkCharacters: 4000,
      }),
    });

    await expect(
      processor.process(createEvent('event-health', 'message-health', '/health now')),
    ).resolves.toBe('replied');
    expect(responses).toEqual(['飞书 WSS 接入、事件去重和回复调度运行正常。']);
  });
});
