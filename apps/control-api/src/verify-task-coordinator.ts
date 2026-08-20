import { randomUUID } from 'node:crypto';

import { TaskRequestSchema } from '@feishu-agent/contracts';
import { createDatabaseClient, TaskRepository } from '@feishu-agent/database';

import { createTaskCoordinator } from './task-coordinator.js';
import { TaskQueueRuntime } from './task-queue.js';

const sql = createDatabaseClient();
const repository = new TaskRepository(sql);
const runId = randomUUID();
const queue = new TaskQueueRuntime({
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queueName: `p2-coordinator-${runId.replaceAll('-', '')}`,
  concurrency: 2,
  timeoutMs: 1_000,
  attempts: 2,
  backoffMs: 10,
  lockDurationMs: 2_000,
  stalledIntervalMs: 1_000,
  maxStalledCount: 1,
});
const coordinator = createTaskCoordinator(repository, queue, [
  {
    id: 'verify-direct',
    version: 1,
    priority: 100,
    enabled: true,
    condition: { commands: ['/verify'] },
    executor: 'direct_tool',
  },
]);
const successfulTaskId = randomUUID();
const failedTaskId = randomUUID();
const attempts = new Map<string, number>();

function createRequest(taskId: string, suffix: string) {
  return TaskRequestSchema.parse({
    id: taskId,
    source: {
      channel: 'feishu',
      eventId: `verify-coordinator-event-${runId}-${suffix}`,
      chatId: `verify-coordinator-chat-${runId}`,
      userId: `verify-user-${suffix}`,
      replyTargetId: `verify-reply-${suffix}`,
    },
    input: { text: '/verify' },
    correlationId: `verify-correlation-${runId}-${suffix}`,
    createdAt: new Date().toISOString(),
  });
}

try {
  await coordinator.startWorker((data) => {
    const attempt = (attempts.get(data.taskId) ?? 0) + 1;
    attempts.set(data.taskId, attempt);
    if (data.taskId === failedTaskId || attempt === 1) {
      throw new Error('Synthetic coordinator failure.');
    }
    return Promise.resolve({ status: 'succeeded', completedAt: new Date().toISOString() });
  }, 'verify-coordinator-worker');

  await coordinator.submit(createRequest(successfulTaskId, 'success'), { chatType: 'group' });
  await coordinator.submit(createRequest(failedTaskId, 'failure'), { chatType: 'group' });
  await queue.waitForResult(successfulTaskId, 10_000);
  let failedJobRejected = false;
  try {
    await queue.waitForResult(failedTaskId, 10_000);
  } catch {
    failedJobRejected = true;
  }

  const [successfulTask, failedTask, successfulAttempts, failedAttempts, snapshot, deadRows] =
    await Promise.all([
      repository.getTask(successfulTaskId),
      repository.getTask(failedTaskId),
      repository.getTaskAttempts(successfulTaskId),
      repository.getTaskAttempts(failedTaskId),
      queue.getSnapshot(),
      sql<{ dead_lettered: boolean }[]>`
        SELECT dead_lettered_at IS NOT NULL AS dead_lettered
        FROM tasks
        WHERE id = ${failedTaskId}
      `,
    ]);
  const result = {
    retryPersisted:
      successfulTask?.status === 'succeeded' &&
      successfulAttempts.length === 2 &&
      successfulAttempts[0]?.outcome === 'failed' &&
      successfulAttempts[1]?.outcome === 'succeeded',
    finalFailurePersisted:
      failedTask?.status === 'failed' &&
      failedAttempts.length === 2 &&
      failedAttempts.every((attempt) => attempt.outcome === 'failed'),
    failedJobRejected,
    redisDeadLettered: snapshot.deadLettered === 1,
    databaseDeadLettered: deadRows[0]?.dead_lettered === true,
  };
  if (Object.values(result).some((passed) => !passed)) {
    throw new Error(`P2 coordinator verification failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await queue.destroyForVerification();
  await queue.close();
  for (const taskId of [successfulTaskId, failedTaskId]) {
    await sql`DELETE FROM audit_events WHERE resource_type = 'task' AND resource_id = ${taskId}`;
    await sql`DELETE FROM tasks WHERE id = ${taskId}`;
  }
  await sql`DELETE FROM conversations WHERE chat_id = ${`verify-coordinator-chat-${runId}`}`;
  await sql.end();
}
