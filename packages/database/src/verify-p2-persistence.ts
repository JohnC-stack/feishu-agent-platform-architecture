import { randomUUID } from 'node:crypto';

import { TaskRequestSchema } from '@feishu-agent/contracts';

import { createDatabaseClient, TaskRepository } from './index.js';

const sql = createDatabaseClient();
const repository = new TaskRepository(sql);
const taskIds: string[] = [];
const conversationIds: string[] = [];

try {
  const chatId = `verify-chat-${randomUUID()}`;
  const firstTaskId = randomUUID();
  const secondTaskId = randomUUID();
  const eventId = `verify-event-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const route = {
    executor: 'direct_tool' as const,
    ruleId: 'verify-direct',
    ruleVersion: 1,
    reason: 'P2 persistence verification.',
  };
  const routeRules = [
    {
      id: `verify-rule-${suffixFrom(chatId)}`,
      version: 1,
      priority: 10,
      enabled: true,
      condition: { commands: ['/verify'] },
      executor: 'direct_tool' as const,
    },
  ];
  await repository.saveRouteRules(routeRules);
  const firstRequest = TaskRequestSchema.parse({
    id: firstTaskId,
    source: {
      channel: 'feishu',
      eventId,
      chatId,
      userId: 'verify-user-1',
      replyTargetId: 'verify-message-1',
    },
    input: { text: '/verify persistence' },
    correlationId: `verify-correlation-${randomUUID()}`,
    createdAt,
  });
  const first = await repository.createTask({ request: firstRequest, route });
  const duplicate = await repository.createTask({
    request: { ...firstRequest, id: randomUUID() },
    route,
  });
  taskIds.push(first.task.id);
  if (first.task.conversationId) {
    conversationIds.push(first.task.conversationId);
  }

  const secondRequest = TaskRequestSchema.parse({
    id: secondTaskId,
    source: {
      channel: 'feishu',
      eventId: `verify-event-${randomUUID()}`,
      chatId,
      userId: 'verify-user-2',
      replyTargetId: 'verify-message-2',
    },
    input: { text: 'second isolated conversation' },
    correlationId: `verify-correlation-${randomUUID()}`,
    createdAt,
  });
  const second = await repository.createTask({ request: secondRequest, route });
  taskIds.push(second.task.id);
  if (second.task.conversationId) {
    conversationIds.push(second.task.conversationId);
  }

  if (!first.task.conversationId || !second.task.conversationId) {
    throw new Error('Verification tasks were not linked to conversations.');
  }
  const firstMessage = await repository.appendConversationMessage({
    conversationId: first.task.conversationId,
    role: 'user',
    content: 'first user message',
    sourceMessageId: 'verify-message-1',
  });
  const duplicateMessage = await repository.appendConversationMessage({
    conversationId: first.task.conversationId,
    role: 'user',
    content: 'first user message',
    sourceMessageId: 'verify-message-1',
  });
  await repository.appendConversationMessage({
    conversationId: second.task.conversationId,
    role: 'user',
    content: 'second user message',
    sourceMessageId: 'verify-message-2',
  });

  await repository.transitionTask({ taskId: first.task.id, to: 'running' });
  await repository.startTaskAttempt({
    taskId: first.task.id,
    attempt: 1,
    workerId: 'verify-worker',
  });
  await repository.finishTaskAttempt({
    taskId: first.task.id,
    attempt: 1,
    outcome: 'succeeded',
  });
  await repository.transitionTask({ taskId: first.task.id, to: 'succeeded' });
  let terminalRestartBlocked = false;
  try {
    await repository.transitionTask({ taskId: first.task.id, to: 'running' });
  } catch {
    terminalRestartBlocked = true;
  }
  const firstContext = await repository.getConversationContext({
    channel: 'feishu',
    chatId,
    userId: 'verify-user-1',
  });
  const secondContext = await repository.getConversationContext({
    channel: 'feishu',
    chatId,
    userId: 'verify-user-2',
  });
  const timeline = await repository.getTaskTimeline(first.task.id);
  const attempts = await repository.getTaskAttempts(first.task.id);
  const summaryVersion = await repository.updateConversationSummary({
    conversationId: first.task.conversationId,
    expectedVersion: firstContext?.summaryVersion ?? 0,
    summary: 'first user summary',
  });
  let staleSummaryBlocked = false;
  try {
    await repository.updateConversationSummary({
      conversationId: first.task.conversationId,
      expectedVersion: 0,
      summary: 'stale summary',
    });
  } catch {
    staleSummaryBlocked = true;
  }
  const activeRouteRules = await repository.getActiveRouteRules();
  const recoverableTasks = await repository.listRecoverableTasks();

  const result = {
    taskIdempotency: first.created && !duplicate.created && duplicate.task.id === first.task.id,
    messageIdempotency:
      firstMessage.created && !duplicateMessage.created && firstMessage.id === duplicateMessage.id,
    conversationIsolation:
      firstContext?.messages.map((message) => message.content).join(',') === 'first user message' &&
      secondContext?.messages.map((message) => message.content).join(',') === 'second user message',
    orderedTimeline:
      timeline.length === 3 && timeline.every((event, index) => event.sequence === index),
    terminalRestartBlocked,
    routeRuleVersioned: activeRouteRules.some(
      (rule) => rule.id === routeRules[0]?.id && rule.version === 1,
    ),
    completedTaskNotRecoverable: !recoverableTasks.some((task) => task.id === first.task.id),
    attemptRecorded: attempts.length === 1 && attempts[0]?.outcome === 'succeeded',
    summaryVersioned: summaryVersion === 1 && staleSummaryBlocked,
  };
  if (Object.values(result).some((passed) => !passed)) {
    throw new Error(`P2 persistence verification failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  for (const taskId of taskIds) {
    await sql`DELETE FROM audit_events WHERE resource_type = 'task' AND resource_id = ${taskId}`;
    await sql`DELETE FROM tasks WHERE id = ${taskId}`;
  }
  for (const conversationId of [...new Set(conversationIds)]) {
    await sql`DELETE FROM conversations WHERE id = ${conversationId}`;
  }
  await sql`DELETE FROM route_rules WHERE id LIKE 'verify-rule-%'`;
  await sql.end();
}

function suffixFrom(value: string): string {
  return value.slice(-12).replaceAll('-', '');
}
