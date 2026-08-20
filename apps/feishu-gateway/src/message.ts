import type { FeishuMessageEvent } from './connection.js';

export interface FeishuAttachmentMetadata {
  type: string;
  fileKey?: string;
  imageKey?: string;
  fileName?: string;
  duration?: number;
}

export interface ParsedFeishuMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: string;
  threadId?: string;
  senderId: string;
  senderType: string;
  messageType: string;
  text: string;
  attachments: FeishuAttachmentMetadata[];
  receivedAt: string;
}

export function parseFeishuMessage(event: FeishuMessageEvent): ParsedFeishuMessage {
  const { message, sender } = event;
  const eventId = event.event_id ?? event.uuid ?? message.message_id;
  const senderId =
    sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? sender.sender_id?.user_id;

  if (!eventId || !message.message_id || !message.chat_id || !senderId) {
    throw new Error('Feishu message event is missing a required identifier.');
  }

  const content = parseContent(message.content);
  const text = removeMentions(extractText(message.message_type, content), message.mentions);

  return {
    eventId,
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    ...(message.thread_id ? { threadId: message.thread_id } : {}),
    senderId,
    senderType: sender.sender_type,
    messageType: message.message_type,
    text,
    attachments: extractAttachments(message.message_type, content),
    receivedAt: timestampToIso(message.create_time),
  };
}

function parseContent(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid content is handled as an empty body while retaining event metadata.
  }
  return {};
}

function extractText(messageType: string, content: Record<string, unknown>): string {
  if (messageType === 'text') {
    return typeof content.text === 'string' ? content.text : '';
  }
  if (messageType === 'post') {
    const texts: string[] = [];
    collectText(content, texts);
    return texts.join('\n');
  }
  return '';
}

function collectText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    output.push(record.text);
  }
  Object.entries(record).forEach(([key, child]) => {
    if (key !== 'text') {
      collectText(child, output);
    }
  });
}

function removeMentions(text: string, mentions: FeishuMessageEvent['message']['mentions']): string {
  let result = normalizeMessageText(text);
  for (const mention of mentions ?? []) {
    result = result.replaceAll(normalizeMessageText(mention.key), ' ');
    if (mention.name) {
      result = result.replaceAll(`@${normalizeMessageText(mention.name)}`, ' ');
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

function normalizeMessageText(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function extractAttachments(
  messageType: string,
  content: Record<string, unknown>,
): FeishuAttachmentMetadata[] {
  const fileKey = typeof content.file_key === 'string' ? content.file_key : undefined;
  const imageKey = typeof content.image_key === 'string' ? content.image_key : undefined;
  const fileName = typeof content.file_name === 'string' ? content.file_name : undefined;
  const duration = typeof content.duration === 'number' ? content.duration : undefined;

  if (!fileKey && !imageKey) {
    return [];
  }

  return [
    {
      type: messageType,
      ...(fileKey ? { fileKey } : {}),
      ...(imageKey ? { imageKey } : {}),
      ...(fileName ? { fileName } : {}),
      ...(duration !== undefined ? { duration } : {}),
    },
  ];
}

function timestampToIso(value: string): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(milliseconds).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
