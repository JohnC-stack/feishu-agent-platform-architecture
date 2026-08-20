import { randomUUID } from 'node:crypto';

import { createDatabaseClient } from '@feishu-agent/database';

import { createWindowsWorker } from '../../windows-worker/src/app.js';
import { createControlApiRuntime } from './runtime.js';
import { readTaskQueueConfig } from './task-queue-config.js';
import { TaskQueueRuntime } from './task-queue.js';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for the real API Agent verification.');
}
if (process.env.API_AGENT_ENABLED?.trim().toLowerCase() !== 'true') {
  throw new Error('API_AGENT_ENABLED=true is required for the real API Agent verification.');
}

const taskId = randomUUID();
const queueName = `verify-p3-api-${taskId}`;
const chatId = `verify-p3-api-chat-${taskId}`;
const userId = `verify-p3-api-user-${taskId}`;
const worker = createWindowsWorker();
let control: Awaited<ReturnType<typeof createControlApiRuntime>> | undefined;
const sql = createDatabaseClient();

try {
  const address = await worker.listen({ host: '127.0.0.1', port: 0 });
  process.env.WINDOWS_WORKER_URL = address;
  process.env.TASK_QUEUE_NAME = queueName;
  process.env.TASK_QUEUE_ATTEMPTS = '1';
  control = await createControlApiRuntime();
  const submitted = await control.inject({
    method: 'POST',
    url: '/v1/tasks',
    payload: {
      task: {
        id: taskId,
        source: {
          channel: 'feishu',
          eventId: `verify-p3-api-event-${taskId}`,
          chatId,
          userId,
          replyTargetId: `verify-p3-api-message-${taskId}`,
        },
        input: {
          text: 'Call the platform.health tool, then briefly confirm that the platform is healthy.',
          attachments: [],
        },
        riskLevel: 'low',
        correlationId: `verify-p3-api-trace-${taskId}`,
        createdAt: new Date().toISOString(),
        metadata: {},
      },
      context: { chatType: 'p2p' },
    },
  });
  if (submitted.statusCode !== 202) {
    throw new Error(`API Agent submission failed: HTTP ${submitted.statusCode}`);
  }
  const task = await waitForTerminalTask(control, taskId);
  const runs = await sql<
    {
      requested_executor: string;
      executor: string | null;
      status: string;
      output: string | null;
      error_category: string | null;
      error_code: string | null;
      error_message: string | null;
      tool_calls: number;
      tool_results: number;
      event_count: number;
    }[]
  >`
    SELECT
      runs.requested_executor,
      runs.executor,
      runs.status,
      runs.output,
      runs.error_category,
      runs.error_code,
      runs.error_message,
      COUNT(events.id) FILTER (WHERE events.kind = 'tool_call')::integer AS tool_calls,
      COUNT(events.id) FILTER (WHERE events.kind = 'tool_result')::integer AS tool_results,
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
    apiRouteUsed: run?.requested_executor === 'api_agent' && run.executor === 'api_agent',
    toolRestricted: run?.tool_calls === 1 && run.tool_results === 1,
    outputPersisted: Boolean(run?.output?.trim()),
    eventsPersisted: (run?.event_count ?? 0) >= 5,
  };
  if (Object.values(verification).some((value) => !value)) {
    throw new Error(
      `API Agent pipeline verification failed: ${JSON.stringify({
        ...verification,
        failure: run
          ? {
              category: run.error_category,
              code: run.error_code,
              message: run.error_message?.slice(0, 1_000),
            }
          : undefined,
      })}`,
    );
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
  const cleanupQueue = new TaskQueueRuntime(
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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/v1/tasks/${id}` });
    if (response.statusCode === 200) {
      const task = response.json<{ status: string }>();
      if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task.status)) {
        return task;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for API Agent completion: ${id}`);
}
