import { randomUUID } from 'node:crypto';

import { createDatabaseClient } from '@feishu-agent/database';

import { createWindowsWorker } from '../../windows-worker/src/app.js';
import { createControlApiRuntime } from './runtime.js';
import { readTaskQueueConfig } from './task-queue-config.js';
import { TaskQueueRuntime } from './task-queue.js';

const taskId = randomUUID();
const queueName = `verify-p3-${taskId}`;
const chatId = `verify-p3-chat-${taskId}`;
const userId = `verify-p3-user-${taskId}`;
const worker = createWindowsWorker();
let control: Awaited<ReturnType<typeof createControlApiRuntime>> | undefined;
let cleanupQueue: TaskQueueRuntime | undefined;
const sql = createDatabaseClient();

try {
  const address = await worker.listen({ host: '127.0.0.1', port: 0 });
  process.env.WINDOWS_WORKER_URL = address;
  process.env.TASK_QUEUE_NAME = queueName;
  control = await createControlApiRuntime();
  const submitted = await control.inject({
    method: 'POST',
    url: '/v1/tasks',
    payload: {
      task: {
        id: taskId,
        source: {
          channel: 'feishu',
          eventId: `verify-p3-event-${taskId}`,
          chatId,
          userId,
          replyTargetId: `verify-p3-message-${taskId}`,
        },
        input: { text: '/ping', command: '/ping', attachments: [] },
        riskLevel: 'low',
        correlationId: `verify-p3-trace-${taskId}`,
        createdAt: new Date().toISOString(),
        metadata: {},
      },
      context: { chatType: 'p2p' },
    },
  });
  if (submitted.statusCode !== 202) {
    throw new Error(`P3 task submission failed: HTTP ${submitted.statusCode}`);
  }
  const task = await waitForTerminalTask(control, taskId);
  const runs = await sql<
    {
      id: string;
      requested_executor: string;
      executor: string | null;
      status: string;
      output: string | null;
      event_count: number;
    }[]
  >`
    SELECT
      runs.id,
      runs.requested_executor,
      runs.executor,
      runs.status,
      runs.output,
      COUNT(events.id)::integer AS event_count
    FROM executor_runs runs
    LEFT JOIN executor_events events ON events.run_id = runs.id
    WHERE runs.task_id = ${taskId}
    GROUP BY runs.id
  `;
  const run = runs[0];
  const verification = {
    submitted: submitted.statusCode === 202,
    taskSucceeded: task.status === 'succeeded',
    directRouteUsed: run?.requested_executor === 'direct_tool' && run.executor === 'direct_tool',
    noModelCall: run?.output?.includes('pong') === true,
    eventsPersisted: (run?.event_count ?? 0) >= 4,
  };
  if (Object.values(verification).some((value) => !value)) {
    throw new Error(`P3 executor pipeline verification failed: ${JSON.stringify(verification)}`);
  }
  console.log(JSON.stringify(verification));
} finally {
  await control?.close();
  await worker.close();
  await sql`DELETE FROM tasks WHERE id = ${taskId}`;
  await sql`
    DELETE FROM conversations
    WHERE chat_id = ${chatId}
      AND user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.conversation_id = conversations.id)
  `;
  await sql.end();
  cleanupQueue = new TaskQueueRuntime(
    readTaskQueueConfig({
      ...process.env,
      TASK_QUEUE_NAME: queueName,
    }),
  );
  await cleanupQueue.destroyForVerification();
  await cleanupQueue.close();
}

async function waitForTerminalTask(
  app: NonNullable<typeof control>,
  id: string,
): Promise<{ status: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/v1/tasks/${id}` });
    if (response.statusCode === 200) {
      const task = response.json<{ status: string }>();
      if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task.status)) {
        return task;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task completion: ${id}`);
}
