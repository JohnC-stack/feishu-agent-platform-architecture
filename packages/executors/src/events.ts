import {
  ExecutorEventSchema,
  type ExecutorEvent,
  type ExecutorEventKind,
  type ExecutorKind,
  type TaskRequest,
} from '@feishu-agent/contracts';

import type { ExecutorContext } from './types.js';

export function createExecutorEvent(
  task: TaskRequest,
  context: ExecutorContext,
  executor: ExecutorKind,
  sequence: number,
  kind: ExecutorEventKind,
  message?: string,
  payload: Record<string, unknown> = {},
): ExecutorEvent {
  return ExecutorEventSchema.parse({
    taskId: task.id,
    runId: context.runId,
    executor,
    correlationId: task.correlationId,
    attempt: context.attempt,
    sequence,
    kind,
    createdAt: new Date().toISOString(),
    ...(message ? { message } : {}),
    payload,
  });
}
