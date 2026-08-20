import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { ExecutorRuntimeError, throwIfAborted } from './errors.js';
import { createExecutorEvent } from './events.js';
import type { Executor, ExecutorContext } from './types.js';

export interface AgentCliExecutorOptions {
  command: string;
  prefixArguments?: readonly string[];
  model?: string;
  sandbox?: 'read-only' | 'workspace-write';
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: Record<string, unknown>;
  message?: string;
}

export class AgentCliExecutor implements Executor {
  public readonly kind = 'agent_cli' as const;
  private readonly maxOutputBytes: number;

  public constructor(private readonly options: AgentCliExecutorOptions) {
    if (!options.command) {
      throw new Error('Agent CLI command is required.');
    }
    this.maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1_024) {
      throw new Error('Agent CLI output limit must be at least 1024 bytes.');
    }
  }

  public async *execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    throwIfAborted(context.signal);
    if (!context.workspacePath) {
      throw new ExecutorRuntimeError(
        'sandbox',
        'AGENT_WORKSPACE_REQUIRED',
        'Agent CLI execution requires an authorized workspace.',
        false,
      );
    }
    let sequence = 0;
    yield createExecutorEvent(
      task,
      context,
      this.kind,
      sequence++,
      'started',
      context.previousSessionId
        ? 'Codex CLI session resume started.'
        : 'Codex CLI execution started.',
      {
        workspacePath: context.workspacePath,
        resumed: Boolean(context.previousSessionId),
        sandbox: this.options.sandbox ?? 'workspace-write',
      },
    );

    const arguments_ = this.buildArguments(context);
    const child = spawn(
      this.options.command,
      [...(this.options.prefixArguments ?? []), ...arguments_],
      {
        cwd: context.workspacePath,
        env: this.options.environment ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let outputBytes = 0;
    let stderr = '';
    let sessionId: string | undefined;
    let finalOutput = '';
    let completed = false;
    let limitError: ExecutorRuntimeError | undefined;
    const close = waitForClose(child);
    const terminate = (): void => terminateChild(child);
    const abortHandler = (): void => terminate();
    context.signal.addEventListener('abort', abortHandler, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000);
      if (outputBytes > this.maxOutputBytes && !limitError) {
        limitError = new ExecutorRuntimeError(
          'sandbox',
          'AGENT_OUTPUT_LIMIT',
          `Agent CLI exceeded the ${this.maxOutputBytes} byte output limit.`,
          false,
        );
        terminate();
      }
    });
    child.stdin.end(buildPrompt(task, context));

    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        outputBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (outputBytes > this.maxOutputBytes) {
          limitError = new ExecutorRuntimeError(
            'sandbox',
            'AGENT_OUTPUT_LIMIT',
            `Agent CLI exceeded the ${this.maxOutputBytes} byte output limit.`,
            false,
          );
          terminate();
          break;
        }
        if (!line.trim()) {
          continue;
        }
        const event = parseCodexEvent(line);
        if (event.type === 'thread.started' && event.thread_id) {
          sessionId = event.thread_id;
          yield createExecutorEvent(task, context, this.kind, sequence++, 'progress', undefined, {
            sessionId,
            eventType: event.type,
          });
          continue;
        }
        if (event.type === 'item.started' && readItemType(event.item) === 'command_execution') {
          yield createExecutorEvent(task, context, this.kind, sequence++, 'tool_call', undefined, {
            toolName: 'codex.command_execution',
            commandSummary: readString(event.item, 'command')?.slice(0, 500),
          });
          continue;
        }
        if (event.type === 'item.completed') {
          const itemType = readItemType(event.item);
          if (itemType === 'agent_message') {
            finalOutput = readString(event.item, 'text') ?? finalOutput;
            yield createExecutorEvent(task, context, this.kind, sequence++, 'progress', undefined, {
              eventType: event.type,
              itemType,
            });
          } else if (itemType === 'command_execution') {
            yield createExecutorEvent(
              task,
              context,
              this.kind,
              sequence++,
              'tool_result',
              undefined,
              {
                toolName: 'codex.command_execution',
                status: readString(event.item, 'status'),
                exitCode: readNumber(event.item, 'exit_code'),
              },
            );
          } else if (itemType) {
            yield createExecutorEvent(task, context, this.kind, sequence++, 'progress', undefined, {
              eventType: event.type,
              itemType,
            });
          }
          continue;
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          throw new ExecutorRuntimeError(
            'dependency',
            'CODEX_TURN_FAILED',
            readCodexError(event),
            true,
          );
        }
        if (event.type === 'turn.completed') {
          completed = true;
          yield createExecutorEvent(
            task,
            context,
            this.kind,
            sequence++,
            'completed',
            'Codex CLI execution completed.',
            { output: finalOutput, ...(sessionId ? { sessionId } : {}), usage: event.usage ?? {} },
          );
        }
      }
      const exit = await close;
      throwIfAborted(context.signal);
      if (limitError) {
        throw limitError;
      }
      if (exit.code !== 0) {
        throw new ExecutorRuntimeError(
          'dependency',
          'CODEX_PROCESS_EXIT',
          `Codex CLI exited with code ${String(exit.code)}${stderr ? `: ${stderr.trim()}` : '.'}`,
          true,
        );
      }
      if (!completed) {
        if (!finalOutput) {
          throw new ExecutorRuntimeError(
            'dependency',
            'CODEX_COMPLETION_MISSING',
            'Codex CLI exited without a completion event.',
            true,
          );
        }
        yield createExecutorEvent(
          task,
          context,
          this.kind,
          sequence,
          'completed',
          'Codex CLI execution completed.',
          { output: finalOutput, ...(sessionId ? { sessionId } : {}) },
        );
      }
    } finally {
      context.signal.removeEventListener('abort', abortHandler);
      if (child.exitCode === null && child.signalCode === null) {
        terminate();
      }
    }
  }

  private buildArguments(context: ExecutorContext): string[] {
    if (context.previousSessionId) {
      return [
        'exec',
        'resume',
        '--json',
        ...(this.options.model ? ['--model', this.options.model] : []),
        context.previousSessionId,
        '-',
      ];
    }
    return [
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      this.options.sandbox ?? 'workspace-write',
      '--cd',
      context.workspacePath ?? '',
      ...(this.options.model ? ['--model', this.options.model] : []),
      '-',
    ];
  }
}

function buildPrompt(task: TaskRequest, context: ExecutorContext): string {
  const prefix = [
    `Task ID: ${task.id}`,
    `Correlation ID: ${task.correlationId}`,
    'Operate only inside the authorized workspace. Do not access credentials or unrelated paths.',
  ];
  if (context.contextText) {
    prefix.push(`Task context:\n${context.contextText}`);
  }
  return `${prefix.join('\n')}\n\nUser task:\n${task.input.text}`;
}

function parseCodexEvent(line: string): CodexEvent {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>).type !== 'string'
    ) {
      throw new Error('JSONL object has no event type.');
    }
    return parsed as CodexEvent;
  } catch (error: unknown) {
    throw new ExecutorRuntimeError(
      'dependency',
      'CODEX_JSONL_INVALID',
      'Codex CLI emitted invalid JSONL output.',
      true,
      { cause: error },
    );
  }
}

function readItemType(item: Record<string, unknown> | undefined): string | undefined {
  return readString(item, 'type');
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readCodexError(event: CodexEvent): string {
  return (
    event.message ??
    readString(event.error, 'message') ??
    'Codex CLI reported an execution failure.'
  ).slice(0, 2_000);
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
}
