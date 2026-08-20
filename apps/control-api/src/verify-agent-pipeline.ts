import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { createDatabaseClient } from '@feishu-agent/database';

import { createWindowsWorker } from '../../windows-worker/src/app.js';
import { createControlApiRuntime } from './runtime.js';
import { readTaskQueueConfig } from './task-queue-config.js';
import { TaskQueueRuntime } from './task-queue.js';

const execFileAsync = promisify(execFile);
const taskId = randomUUID();
const queueName = `verify-p3-agent-${taskId}`;
const chatId = `verify-p3-agent-chat-${taskId}`;
const userId = `verify-p3-agent-user-${taskId}`;
const workspacePath = process.cwd();
process.env.AGENT_AUTHORIZED_WORKSPACE_ROOTS = workspacePath;
const before = await readGitStatus();
const worker = createWindowsWorker();
let control: Awaited<ReturnType<typeof createControlApiRuntime>> | undefined;
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
          eventId: `verify-p3-agent-event-${taskId}`,
          chatId,
          userId,
          replyTargetId: `verify-p3-agent-message-${taskId}`,
        },
        input: {
          text: 'Reply with exactly P3_AGENT_PIPELINE_OK. Do not modify files or run commands.',
          command: '/agent',
          attachments: [],
        },
        riskLevel: 'low',
        correlationId: `verify-p3-agent-trace-${taskId}`,
        createdAt: new Date().toISOString(),
        metadata: { workspacePath },
      },
      context: { chatType: 'p2p' },
    },
  });
  if (submitted.statusCode !== 202) {
    throw new Error(`Agent pipeline submission failed: HTTP ${submitted.statusCode}`);
  }
  const task = await waitForTerminalTask(control, taskId);
  const runs = await sql<
    {
      requested_executor: string;
      executor: string | null;
      status: string;
      output: string | null;
      session_id: string | null;
      workspace_path: string | null;
      event_count: number;
      released_at: Date | null;
    }[]
  >`
    SELECT
      runs.requested_executor,
      runs.executor,
      runs.status,
      runs.output,
      runs.session_id,
      runs.workspace_path,
      COUNT(events.id)::integer AS event_count,
      bindings.released_at
    FROM executor_runs runs
    LEFT JOIN executor_events events ON events.run_id = runs.id
    LEFT JOIN workspace_bindings bindings ON bindings.run_id = runs.id
    WHERE runs.task_id = ${taskId}
    GROUP BY runs.id, bindings.released_at
  `;
  const run = runs[0];
  const after = await readGitStatus();
  const verification = {
    submitted: submitted.statusCode === 202,
    taskSucceeded: task.status === 'succeeded',
    agentRouteUsed: run?.requested_executor === 'agent_cli' && run.executor === 'agent_cli',
    outputPersisted: run?.output?.trim() === 'P3_AGENT_PIPELINE_OK',
    sessionPersisted: Boolean(run?.session_id),
    workspacePersisted: run?.workspace_path === workspacePath,
    workspaceReleased: Boolean(run?.released_at),
    eventsPersisted: (run?.event_count ?? 0) >= 3,
    workspaceUnchanged: before === after,
  };
  if (Object.values(verification).some((value) => !value)) {
    throw new Error(`Agent pipeline verification failed: ${JSON.stringify(verification)}`);
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
  throw new Error(`Timed out waiting for Agent task completion: ${id}`);
}

async function readGitStatus(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], {
    cwd: workspacePath,
    windowsHide: true,
  });
  return stdout;
}
