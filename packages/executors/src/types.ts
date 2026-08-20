import type { ExecutorEvent, ExecutorKind, TaskRequest } from '@feishu-agent/contracts';

export interface ExecutorContext {
  signal: AbortSignal;
  runId: string;
  attempt: number;
  approvedToolNames: ReadonlySet<string>;
  workspacePath?: string;
  previousSessionId?: string;
  contextText?: string;
}

export interface Executor {
  readonly kind: ExecutorKind;
  execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent>;
}

export interface ExecutorRunResult {
  events: ExecutorEvent[];
  output?: string;
  sessionId?: string;
}
