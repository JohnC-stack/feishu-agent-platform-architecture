import { randomUUID } from 'node:crypto';

import type { ExecutorEvent, ExecutorExecutionResult, TaskRequest } from '@feishu-agent/contracts';

import { createDatabaseClient } from './index.js';
import { TaskRepository } from './task-repository.js';

const sql = createDatabaseClient();
const repository = new TaskRepository(sql);
const taskId = randomUUID();
const runId = randomUUID();
const eventId = `verify-p3-${randomUUID()}`;
const correlationId = `trace-${randomUUID()}`;

const task: TaskRequest = {
  id: taskId,
  source: {
    channel: 'feishu',
    eventId,
    chatId: 'verify-p3-chat',
    userId: 'verify-p3-user',
    replyTargetId: 'verify-p3-message',
  },
  input: { text: '/ping', command: '/ping', attachments: [] },
  requestedExecutor: 'direct_tool',
  riskLevel: 'low',
  correlationId,
  createdAt: new Date().toISOString(),
  metadata: {},
};

try {
  await repository.createTask({
    request: task,
    route: {
      executor: 'direct_tool',
      ruleId: 'health-direct',
      ruleVersion: 1,
      reason: 'P3 persistence verification.',
    },
  });
  const started = await repository.beginExecutorRun({
    runId,
    taskId,
    attempt: 1,
    requestedExecutor: 'direct_tool',
  });
  const createdAt = new Date().toISOString();
  const events: ExecutorEvent[] = [
    {
      taskId,
      runId: started.runId,
      executor: 'direct_tool',
      correlationId,
      attempt: 1,
      sequence: 0,
      kind: 'started',
      createdAt,
      message: 'Direct execution started.',
      payload: { modelCalled: false },
    },
    {
      taskId,
      runId: started.runId,
      executor: 'direct_tool',
      correlationId,
      attempt: 1,
      sequence: 1,
      kind: 'completed',
      createdAt: new Date().toISOString(),
      message: 'Direct execution completed.',
      payload: { modelCalled: false, output: 'pong' },
    },
  ];
  const inserted = await repository.appendExecutorEvents(events);
  const result: ExecutorExecutionResult = {
    taskId,
    runId: started.runId,
    executor: 'direct_tool',
    status: 'succeeded',
    events,
    output: 'pong',
  };
  await repository.finishExecutorRun(result);
  const persisted = await repository.getExecutorRun(started.runId);
  const reconstructed = await repository.getTaskExecutionRequest(taskId);
  const verification = {
    runCreated: started.created,
    eventsPersisted: inserted === 2 && persisted?.eventCount === 2,
    auditFieldsPreserved:
      persisted?.taskId === taskId &&
      persisted.requestedExecutor === 'direct_tool' &&
      persisted.executor === 'direct_tool' &&
      persisted.status === 'succeeded',
    outputPersisted: persisted?.output === 'pong',
    taskReconstructed:
      reconstructed?.source.chatId === task.source.chatId &&
      reconstructed.source.userId === task.source.userId &&
      reconstructed.input.command === '/ping',
  };
  if (Object.values(verification).some((value) => !value)) {
    throw new Error(`P3 persistence verification failed: ${JSON.stringify(verification)}`);
  }
  console.log(JSON.stringify(verification));
} finally {
  await sql`DELETE FROM tasks WHERE id = ${taskId}`;
  await sql`
    DELETE FROM conversations
    WHERE chat_id = 'verify-p3-chat'
      AND user_id = 'verify-p3-user'
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.conversation_id = conversations.id)
  `;
  await sql.end();
}
