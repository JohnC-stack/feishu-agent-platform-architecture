import {
  ExecutorExecutionResultSchema,
  type ExecutorEvent,
  type ExecutorExecutionResult,
  type ExecutorKind,
  type TaskRequest,
} from '@feishu-agent/contracts';

import { ExecutorCircuitBreaker } from './circuit-breaker.js';
import { classifyExecutorError, ExecutorRuntimeError } from './errors.js';
import { createExecutorEvent } from './events.js';
import type { Executor, ExecutorContext } from './types.js';
import { validateResourceLimits, type ExecutorResourceLimits } from './workspace.js';

export interface ExecutorRuntimeOptions {
  executors: readonly Executor[];
  fallbackOrder?: Partial<Record<ExecutorKind, readonly ExecutorKind[]>>;
  circuitBreaker?: ExecutorCircuitBreaker;
  limits?: Partial<ExecutorResourceLimits>;
}

export class ExecutorRuntime {
  private readonly executors = new Map<ExecutorKind, Executor>();
  private readonly fallbackOrder: Partial<Record<ExecutorKind, readonly ExecutorKind[]>>;
  private readonly circuitBreaker: ExecutorCircuitBreaker;
  private readonly limits: ExecutorResourceLimits;

  public constructor(options: ExecutorRuntimeOptions) {
    for (const executor of options.executors) {
      if (this.executors.has(executor.kind)) {
        throw new Error(`Duplicate executor registration: ${executor.kind}`);
      }
      this.executors.set(executor.kind, executor);
    }
    this.fallbackOrder = options.fallbackOrder ?? {};
    this.circuitBreaker = options.circuitBreaker ?? new ExecutorCircuitBreaker();
    this.limits = validateResourceLimits({
      timeoutMs: options.limits?.timeoutMs ?? 300_000,
      maxOutputBytes: options.limits?.maxOutputBytes ?? 2_000_000,
      maxEvents: options.limits?.maxEvents ?? 1_000,
    });
  }

  public async run(
    task: TaskRequest,
    context: ExecutorContext,
    requestedExecutor: ExecutorKind,
  ): Promise<ExecutorExecutionResult> {
    const controller = new AbortController();
    const abortParent = (): void => controller.abort(context.signal.reason);
    if (context.signal.aborted) {
      abortParent();
    } else {
      context.signal.addEventListener('abort', abortParent, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(
        new ExecutorRuntimeError(
          'timeout',
          'EXECUTOR_TIMEOUT',
          `Executor runtime exceeded ${this.limits.timeoutMs} ms.`,
          false,
        ),
      );
    }, this.limits.timeoutMs);
    const events: ExecutorEvent[] = [];
    const candidates = uniqueKinds([
      requestedExecutor,
      ...(this.fallbackOrder[requestedExecutor] ?? []),
    ]);
    let lastFailure: ExecutorRuntimeError | undefined;
    let sequence = 0;
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const kind = candidates[index];
        if (!kind) {
          continue;
        }
        const executor = this.executors.get(kind);
        if (!executor) {
          lastFailure = new ExecutorRuntimeError(
            'dependency',
            'EXECUTOR_NOT_REGISTERED',
            `Executor is not registered: ${kind}`,
            false,
          );
          continue;
        }
        if (index > 0 && kind === 'agent_cli' && !context.workspacePath) {
          events.push(
            createExecutorEvent(
              task,
              { ...context, signal: controller.signal },
              kind,
              sequence++,
              'progress',
              'Agent CLI fallback skipped because no authorized workspace was bound.',
              { fallbackSkipped: true, reason: 'workspace_required' },
            ),
          );
          continue;
        }
        if (!this.circuitBreaker.canExecute(kind)) {
          events.push(
            createExecutorEvent(
              task,
              { ...context, signal: controller.signal },
              kind,
              sequence++,
              'progress',
              `Executor circuit is open; skipped ${kind}.`,
              { circuitState: 'open' },
            ),
          );
          lastFailure = new ExecutorRuntimeError(
            'dependency',
            'EXECUTOR_CIRCUIT_OPEN',
            `Executor circuit is open: ${kind}`,
            true,
          );
          continue;
        }
        try {
          const candidateContext: ExecutorContext = { ...context, signal: controller.signal };
          let completedEvent: ExecutorEvent | undefined;
          for await (const event of executor.execute(task, candidateContext)) {
            if (events.length >= this.limits.maxEvents) {
              throw new ExecutorRuntimeError(
                'sandbox',
                'EXECUTOR_EVENT_LIMIT',
                `Executor exceeded the ${this.limits.maxEvents} event limit.`,
                false,
              );
            }
            const normalized = { ...event, sequence: sequence++ };
            events.push(normalized);
            if (normalized.kind === 'completed') {
              completedEvent = normalized;
            }
          }
          if (!completedEvent) {
            throw new ExecutorRuntimeError(
              'internal',
              'EXECUTOR_COMPLETION_MISSING',
              `Executor ended without a completed event: ${kind}`,
              true,
            );
          }
          this.circuitBreaker.recordSuccess(kind);
          return ExecutorExecutionResultSchema.parse({
            taskId: task.id,
            runId: context.runId,
            executor: kind,
            status: 'succeeded',
            events,
            ...readCompletion(completedEvent),
          });
        } catch (error: unknown) {
          const failure = controller.signal.aborted
            ? classifyExecutorError(controller.signal.reason)
            : classifyExecutorError(error);
          lastFailure = failure;
          if (failure.retryable) {
            this.circuitBreaker.recordFailure(kind);
          }
          const hasFallback = index < candidates.length - 1 && failure.retryable;
          if (hasFallback) {
            events.push(
              createExecutorEvent(
                task,
                { ...context, signal: controller.signal },
                kind,
                sequence++,
                'progress',
                `Executor ${kind} failed; applying configured fallback.`,
                { failure: failure.toFailure() },
              ),
            );
            continue;
          }
          break;
        }
      }
      const failure =
        lastFailure ??
        new ExecutorRuntimeError(
          'dependency',
          'EXECUTOR_UNAVAILABLE',
          'No executor candidate was available.',
          true,
        );
      const status =
        failure.category === 'cancelled'
          ? 'cancelled'
          : failure.category === 'timeout'
            ? 'expired'
            : 'failed';
      events.push(
        createExecutorEvent(
          task,
          { ...context, signal: controller.signal },
          requestedExecutor,
          sequence,
          status === 'cancelled' ? 'cancelled' : 'failed',
          failure.message,
          { failure: failure.toFailure() },
        ),
      );
      return ExecutorExecutionResultSchema.parse({
        taskId: task.id,
        runId: context.runId,
        executor: requestedExecutor,
        status,
        events,
        failure: failure.toFailure(),
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abortParent);
    }
  }
}

function uniqueKinds(kinds: readonly ExecutorKind[]): ExecutorKind[] {
  return [...new Set(kinds)];
}

function readCompletion(event: ExecutorEvent): { output?: string; sessionId?: string } {
  const output = event.payload.output;
  const sessionId = event.payload.sessionId;
  return {
    ...(typeof output === 'string' ? { output: output.slice(0, 100_000) } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
  };
}
