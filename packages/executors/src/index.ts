import type { ExecutorEvent, ExecutorKind, TaskRequest } from '@feishu-agent/contracts';

export interface ExecutorContext {
  signal: AbortSignal;
  workspacePath?: string;
  approvedToolNames: ReadonlySet<string>;
}

export interface Executor {
  readonly kind: ExecutorKind;
  execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent>;
}

export class NoopExecutor implements Executor {
  public readonly kind: ExecutorKind;

  public constructor(kind: ExecutorKind) {
    this.kind = kind;
  }

  // Async generator is required by the streaming Executor contract even for this P0 no-op.
  // eslint-disable-next-line @typescript-eslint/require-await
  public async *execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    if (context.signal.aborted) {
      yield createEvent(task.id, 0, 'cancelled', 'Task was cancelled before execution.');
      return;
    }

    yield createEvent(task.id, 0, 'started', `${this.kind} executor accepted the task.`);
    yield createEvent(task.id, 1, 'completed', 'P0 scaffold completed without side effects.');
  }
}

function createEvent(
  taskId: string,
  sequence: number,
  kind: ExecutorEvent['kind'],
  message: string,
): ExecutorEvent {
  return {
    taskId,
    sequence,
    kind,
    message,
    createdAt: new Date().toISOString(),
    payload: {},
  };
}
