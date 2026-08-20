import { describe, expect, it } from 'vitest';

import type { FeishuMessageEvent } from './connection.js';
import { parseFeishuMessage } from './message.js';

function createEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    event_id: 'event-1',
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_user' },
    },
    message: {
      message_id: 'message-1',
      create_time: '1787220000000',
      chat_id: 'chat-1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 /ping' }),
      mentions: [
        {
          key: '@_user_1',
          id: { open_id: 'ou_bot' },
          name: '机器人',
        },
      ],
    },
    ...overrides,
  };
}

describe('parseFeishuMessage', () => {
  it('normalizes text and removes bot mention placeholders', () => {
    expect(parseFeishuMessage(createEvent())).toMatchObject({
      eventId: 'event-1',
      messageId: 'message-1',
      senderId: 'ou_user',
      text: '/ping',
      attachments: [],
    });
  });

  it('normalizes a visible group mention, full-width slash, and zero-width characters', () => {
    const event = createEvent({
      message: {
        message_id: 'message-2',
        create_time: '1787220000000',
        chat_id: 'chat-1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@机器人\u200b ／health' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot' },
            name: '机器人',
          },
        ],
      },
    });

    expect(parseFeishuMessage(event).text).toBe('/health');
  });

  it('extracts attachment metadata without downloading content', () => {
    const event = createEvent({
      message: {
        message_id: 'message-2',
        create_time: '1787220000000',
        chat_id: 'chat-1',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file-key', file_name: 'report.pdf' }),
      },
    });

    expect(parseFeishuMessage(event).attachments).toEqual([
      { type: 'file', fileKey: 'file-key', fileName: 'report.pdf' },
    ]);
  });
});
