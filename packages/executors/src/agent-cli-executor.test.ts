import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { AgentCliExecutor } from './agent-cli-executor.js';

const temporaryDirectories: string[] = [];

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-cli',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: 'Inspect the authorized workspace', attachments: [] },
  riskLevel: 'low',
  correlationId: 'trace-cli',
  createdAt: '2026-08-20T00:00:00.000Z',
  metadata: {},
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('AgentCliExecutor', () => {
  it('parses Codex JSONL, captures the session, and returns unified events', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'feishu-agent-cli-'));
    temporaryDirectories.push(workspace);
    const script = [
      'process.stdin.resume();',
      "process.stdin.on('end', () => {",
      "console.log(JSON.stringify({type:'thread.started',thread_id:'cli-session-1'}));",
      "console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'git status'}}));",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',status:'completed',exit_code:0}}));",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Workspace is clean.'}}));",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:4}}));",
      '});',
    ].join('');
    const executor = new AgentCliExecutor({
      command: process.execPath,
      prefixArguments: ['-e', script],
      maxOutputBytes: 20_000,
    });
    const events: ExecutorEvent[] = [];
    for await (const event of executor.execute(task, {
      signal: new AbortController().signal,
      runId: 'a13f580d-eb83-4524-b440-9e7677726464',
      attempt: 1,
      approvedToolNames: new Set(),
      workspacePath: workspace,
    })) {
      events.push(event);
    }

    expect(events.map(({ kind }) => kind)).toEqual([
      'started',
      'progress',
      'tool_call',
      'tool_result',
      'progress',
      'completed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      output: 'Workspace is clean.',
      sessionId: 'cli-session-1',
    });
  });

  it('requires an authorized workspace binding', async () => {
    const executor = new AgentCliExecutor({ command: process.execPath });
    await expect(async () => {
      for await (const event of executor.execute(task, {
        signal: new AbortController().signal,
        runId: 'a13f580d-eb83-4524-b440-9e7677726464',
        attempt: 1,
        approvedToolNames: new Set(),
      })) {
        void event;
        // Consume until workspace validation rejects the run.
      }
    }).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_REQUIRED' });
  });

  it('terminates an active CLI child when the task is cancelled', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'feishu-agent-cli-'));
    temporaryDirectories.push(workspace);
    const controller = new AbortController();
    const executor = new AgentCliExecutor({
      command: process.execPath,
      prefixArguments: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'],
    });
    const consume = async (): Promise<void> => {
      for await (const event of executor.execute(task, {
        signal: controller.signal,
        runId: 'a13f580d-eb83-4524-b440-9e7677726464',
        attempt: 1,
        approvedToolNames: new Set(),
        workspacePath: workspace,
      })) {
        void event;
        // Wait until cancellation terminates the fake CLI process.
      }
    };
    setTimeout(() => controller.abort(), 50);

    await expect(consume()).rejects.toMatchObject({ category: 'cancelled' });
  });
});
