import { randomUUID } from 'node:crypto';

import { TaskRequestSchema } from '@feishu-agent/contracts';

import { createDatabaseClient, TaskRepository } from './index.js';

const sql = createDatabaseClient();
const repository = new TaskRepository(sql);
const runId = randomUUID();
const identities = [
  { chatId: `verify-group-a-${runId}`, userId: 'verify-user-1' },
  { chatId: `verify-group-a-${runId}`, userId: 'verify-user-2' },
  { chatId: `verify-group-b-${runId}`, userId: 'verify-user-1' },
  { chatId: `verify-group-b-${runId}`, userId: 'verify-user-2' },
];
const requests = Array.from({ length: 20 }, (_, index) => {
  const identity = identities[index % identities.length];
  if (!identity) {
    throw new Error('Concurrency verification identity allocation failed.');
  }
  return TaskRequestSchema.parse({
    id: randomUUID(),
    source: {
      channel: 'feishu',
      eventId: `verify-concurrent-event-${runId}-${index}`,
      chatId: identity.chatId,
      userId: identity.userId,
      replyTargetId: `verify-reply-${runId}-${index}`,
    },
    input: { text: `message-${index}` },
    correlationId: `verify-correlation-${runId}-${index}`,
    createdAt: new Date(Date.now() + index).toISOString(),
  });
});

try {
  const persisted = await Promise.all(
    requests.map((request) =>
      repository.createTask({
        request,
        route: {
          executor: 'direct_tool',
          ruleId: 'verify-concurrency',
          ruleVersion: 1,
          reason: 'P2 concurrent isolation verification.',
        },
      }),
    ),
  );
  await Promise.all(
    persisted.map(async ({ task }, index) => {
      if (!task.conversationId) {
        throw new Error(`Task has no conversation: ${task.id}`);
      }
      await repository.appendConversationMessage({
        conversationId: task.conversationId,
        role: 'user',
        content: `message-${index}`,
        sourceMessageId: `verify-reply-${runId}-${index}`,
      });
    }),
  );

  const conversationIdsByIdentity = new Map<string, Set<string>>();
  persisted.forEach(({ task }, index) => {
    const request = requests[index];
    if (!request || !task.conversationId) {
      throw new Error('Persisted task mapping is incomplete.');
    }
    const key = `${request.source.chatId}:${request.source.userId}`;
    const ids = conversationIdsByIdentity.get(key) ?? new Set<string>();
    ids.add(task.conversationId);
    conversationIdsByIdentity.set(key, ids);
  });
  const uniqueConversationIds = new Set(
    persisted.flatMap(({ task }) => (task.conversationId ? [task.conversationId] : [])),
  );
  const taskRows = await sql<
    { id: string; conversation_id: string; reply_target_id: string; correlation_id: string }[]
  >`
    SELECT id, conversation_id, reply_target_id, correlation_id
    FROM tasks
    WHERE source_event_id LIKE ${`verify-concurrent-event-${runId}-%`}
  `;
  const rowsById = new Map(taskRows.map((row) => [row.id, row]));
  const replyTargetsPreserved = requests.every((request) => {
    const row = rowsById.get(request.id);
    return (
      row?.reply_target_id === request.source.replyTargetId &&
      row.correlation_id === request.correlationId
    );
  });
  const contexts = await Promise.all(
    identities.map((identity) =>
      repository.getConversationContext({ channel: 'feishu', ...identity }, 20),
    ),
  );
  const contextIsolation = contexts.every((context, identityIndex) => {
    if (!context) {
      return false;
    }
    const expectedIndexes = requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => {
        const identity = identities[identityIndex];
        return (
          identity &&
          request.source.chatId === identity.chatId &&
          request.source.userId === identity.userId
        );
      })
      .map(({ index }) => `message-${index}`)
      .sort();
    return (
      context.messages
        .map((message) => message.content)
        .sort()
        .join('|') === expectedIndexes.join('|')
    );
  });
  const result = {
    taskCount: taskRows.length,
    oneConversationPerIdentity: [...conversationIdsByIdentity.values()].every(
      (ids) => ids.size === 1,
    ),
    distinctIdentityConversations: uniqueConversationIds.size === identities.length,
    replyTargetsPreserved,
    contextIsolation,
  };
  if (
    result.taskCount !== requests.length ||
    Object.entries(result).some(([key, value]) => key !== 'taskCount' && value !== true)
  ) {
    throw new Error(`P2 concurrency verification failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await sql`
    DELETE FROM audit_events
    WHERE resource_type = 'task'
      AND resource_id IN (
        SELECT id::text FROM tasks WHERE source_event_id LIKE ${`verify-concurrent-event-${runId}-%`}
      )
  `;
  await sql`DELETE FROM tasks WHERE source_event_id LIKE ${`verify-concurrent-event-${runId}-%`}`;
  await sql`DELETE FROM conversations WHERE chat_id IN (${identities[0]?.chatId ?? ''}, ${identities[2]?.chatId ?? ''})`;
  await sql.end();
}
