import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { ExecutorRuntimeError, throwIfAborted } from './errors.js';
import { createExecutorEvent } from './events.js';
import type { ToolGateway } from './tool-gateway.js';
import type { Executor, ExecutorContext } from './types.js';

export interface DirectCommandRoute {
  command: string;
  toolName: string;
  parseArguments?(task: TaskRequest): unknown;
}

export class DirectToolExecutor implements Executor {
  public readonly kind = 'direct_tool' as const;
  private readonly routes = new Map<string, DirectCommandRoute>();

  public constructor(
    private readonly gateway: ToolGateway,
    routes: readonly DirectCommandRoute[],
  ) {
    for (const route of routes) {
      const key = route.command.toLowerCase();
      if (!key.startsWith('/') || this.routes.has(key)) {
        throw new Error(`Invalid or duplicate direct command route: ${route.command}`);
      }
      this.routes.set(key, route);
    }
  }

  public async *execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    throwIfAborted(context.signal);
    const command = readCommand(task);
    const route = command ? this.routes.get(command.toLowerCase()) : undefined;
    if (!route) {
      throw new ExecutorRuntimeError(
        'validation',
        'DIRECT_COMMAND_UNKNOWN',
        `No deterministic tool route exists for command: ${command ?? '(none)'}`,
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
      `Direct tool route selected ${route.toolName}.`,
      { modelCalled: false, toolName: route.toolName },
    );
    yield createExecutorEvent(task, context, this.kind, sequence++, 'tool_call', undefined, {
      toolName: route.toolName,
      operation: 'deterministic',
    });
    const result = await this.gateway.invoke(
      route.toolName,
      route.parseArguments?.(task) ?? {},
      context.approvedToolNames,
      { task, signal: context.signal },
    );
    yield createExecutorEvent(task, context, this.kind, sequence++, 'tool_result', undefined, {
      toolName: result.toolName,
      operation: result.operation,
      durationMs: result.durationMs,
      truncated: result.truncated,
      output: result.output,
    });
    yield createExecutorEvent(
      task,
      context,
      this.kind,
      sequence,
      'completed',
      'Deterministic tool execution completed without a model call.',
      { modelCalled: false, output: result.output },
    );
  }
}

function readCommand(task: TaskRequest): string | undefined {
  if (task.input.command) {
    return task.input.command;
  }
  const token = task.input.text.trim().split(/\s+/, 1)[0];
  return token?.startsWith('/') ? token : undefined;
}
