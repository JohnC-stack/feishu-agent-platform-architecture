import type { ExecutorEvent, ExecutorKind, TaskRequest } from '@feishu-agent/contracts';

import { throwIfAborted } from './errors.js';
import { createExecutorEvent } from './events.js';
import type { Executor, ExecutorContext } from './types.js';

export class NoopExecutor implements Executor {
  public constructor(public readonly kind: ExecutorKind) {}

  // Async generation is required by the streaming executor protocol.
  // eslint-disable-next-line @typescript-eslint/require-await
  public async *execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    throwIfAborted(context.signal);
    yield createExecutorEvent(task, context, this.kind, 0, 'started', 'No-op executor started.');
    yield createExecutorEvent(
      task,
      context,
      this.kind,
      1,
      'completed',
      'No-op executor completed.',
      {
        output: 'noop',
      },
    );
  }
}
