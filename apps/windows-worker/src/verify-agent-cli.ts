import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type { ExecutorExecutionResult, TaskRequest } from '@feishu-agent/contracts';

import { createWindowsWorkerRuntime } from './runtime.js';

const execFileAsync = promisify(execFile);
const workspacePath = process.cwd();
process.env.AGENT_AUTHORIZED_WORKSPACE_ROOTS = workspacePath;
const before = await readGitStatus(workspacePath);
const runtime = createWindowsWorkerRuntime();

const first = await execute(
  'Reply with exactly P3_AGENT_CLI_OK. Do not modify files or run commands.',
);
if (
  first.status !== 'succeeded' ||
  first.output?.trim() !== 'P3_AGENT_CLI_OK' ||
  !first.sessionId
) {
  throw new Error(`Initial Agent CLI verification failed: ${summarize(first)}`);
}
const resumed = await execute(
  'Reply with exactly P3_AGENT_CLI_RESUME_OK. Do not modify files or run commands.',
  first.sessionId,
);
if (resumed.status !== 'succeeded' || resumed.output?.trim() !== 'P3_AGENT_CLI_RESUME_OK') {
  throw new Error(`Resumed Agent CLI verification failed: ${summarize(resumed)}`);
}
const after = await readGitStatus(workspacePath);
const verification = {
  jsonlParsed: first.events.some(({ kind }) => kind === 'progress'),
  sessionCaptured: Boolean(first.sessionId),
  sessionResumed: resumed.sessionId === first.sessionId,
  workspaceBound: first.events[0]?.payload.workspacePath === workspacePath,
  workspaceUnchanged: before === after,
  completed: first.status === 'succeeded' && resumed.status === 'succeeded',
};
if (Object.values(verification).some((value) => !value)) {
  throw new Error(`Agent CLI verification failed: ${JSON.stringify(verification)}`);
}
console.log(JSON.stringify(verification));

async function execute(text: string, previousSessionId?: string): Promise<ExecutorExecutionResult> {
  const taskId = randomUUID();
  const task: TaskRequest = {
    id: taskId,
    source: {
      channel: 'feishu',
      eventId: `verify-agent-cli-${taskId}`,
      chatId: 'verify-agent-cli-chat',
      userId: 'verify-agent-cli-user',
      replyTargetId: `verify-agent-cli-message-${taskId}`,
    },
    input: { text, command: '/agent', attachments: [] },
    requestedExecutor: 'agent_cli',
    riskLevel: 'low',
    correlationId: `verify-agent-cli-trace-${taskId}`,
    createdAt: new Date().toISOString(),
    metadata: {},
  };
  return runtime.executionService.execute({
    task,
    executor: 'agent_cli',
    runId: randomUUID(),
    attempt: 1,
    approvedToolNames: [],
    workspacePath,
    ...(previousSessionId ? { previousSessionId } : {}),
  });
}

async function readGitStatus(workspace: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], {
    cwd: workspace,
    windowsHide: true,
  });
  return stdout;
}

function summarize(result: ExecutorExecutionResult): string {
  return JSON.stringify({
    status: result.status,
    output: result.output,
    sessionId: result.sessionId,
    failure: result.failure,
    eventCount: result.events.length,
  });
}
