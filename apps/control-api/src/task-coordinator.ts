import type {
  RouteChatType,
  RouteDecision,
  RouteRule,
  TaskRequest,
  TaskStatus,
} from '@feishu-agent/contracts';
import type { PersistedTask, TaskRepository } from '@feishu-agent/database';
import { RuleRouter } from '@feishu-agent/policy';

import {
  TaskCancelledError,
  TaskTimeoutError,
  type TaskHandler,
  type TaskJobData,
  type TaskQueueHooks,
  type TaskQueueRuntime,
} from './task-queue.js';

export interface TaskRepositoryPort {
  createTask(input: {
    request: TaskRequest;
    route: RouteDecision;
    maxAttempts?: number;
  }): Promise<{ task: PersistedTask; created: boolean }>;
  getTask(taskId: string): Promise<PersistedTask | undefined>;
  listRecoverableTasks(limit?: number): Promise<PersistedTask[]>;
  requestTaskCancellation(taskId: string): Promise<boolean>;
  transitionTask(input: {
    taskId: string;
    to: TaskStatus;
    reason?: string;
  }): Promise<PersistedTask>;
  startTaskAttempt(input: { taskId: string; attempt: number; workerId: string }): Promise<void>;
  finishTaskAttempt(input: {
    taskId: string;
    attempt: number;
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'stalled';
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void>;
  markTaskDeadLettered(taskId: string): Promise<void>;
}

export interface TaskQueuePort {
  enqueue(data: TaskJobData): Promise<{ jobId: string; deduplicated: boolean }>;
  cancel(taskId: string): Promise<'cancelled' | 'cancelling' | 'not_found'>;
  startWorker(handler: TaskHandler, hooks?: TaskQueueHooks): Promise<void>;
}

export interface TaskSubmissionResult {
  task: PersistedTask;
  route: RouteDecision;
  created: boolean;
  queueDeduplicated: boolean;
}

export interface TaskRoutingInput {
  chatType: RouteChatType;
}

export class TaskCoordinator {
  private readonly router: RuleRouter;

  public constructor(
    private readonly repository: TaskRepositoryPort,
    private readonly queue: TaskQueuePort,
    rules: RouteRule[],
    fallbackExecutor: RouteDecision['executor'] = 'api_agent',
  ) {
    this.router = new RuleRouter(rules, fallbackExecutor);
  }

  public async submit(
    request: TaskRequest,
    routingInput: TaskRoutingInput,
  ): Promise<TaskSubmissionResult> {
    const command = readCommand(request);
    const route = this.router.route({
      chatType: routingInput.chatType,
      ...(command ? { command } : {}),
      text: request.input.text,
      riskLevel: request.riskLevel,
      attachmentCount: request.input.attachments.length,
    });
    const persisted = await this.repository.createTask({ request, route });
    const queued = await this.queue.enqueue(toJobData(persisted.task));
    return {
      ...persisted,
      route,
      queueDeduplicated: queued.deduplicated,
    };
  }

  public getTask(taskId: string): Promise<PersistedTask | undefined> {
    return this.repository.getTask(taskId);
  }

  public startWorker(handler: TaskHandler, workerId = `control-api-${process.pid}`): Promise<void> {
    const startedAttempts = new Set<string>();
    const attemptKey = (taskId: string, attempt: number): string => `${taskId}:${attempt}`;
    return this.queue.startWorker(handler, {
      onAttemptStarted: async (data, context) => {
        const task = await this.repository.getTask(data.taskId);
        if (!task) {
          throw new Error(`Scheduled task not found: ${data.taskId}`);
        }
        if (task.status === 'queued') {
          await this.repository.transitionTask({
            taskId: data.taskId,
            to: 'running',
            reason: `Worker ${workerId} started attempt ${context.attempt}.`,
          });
        } else if (task.status !== 'running') {
          throw new TaskCancelledError(data.taskId);
        }
        await this.repository.startTaskAttempt({
          taskId: data.taskId,
          attempt: context.attempt,
          workerId,
        });
        startedAttempts.add(attemptKey(data.taskId, context.attempt));
      },
      onAttemptSucceeded: async (data, context) => {
        await this.repository.finishTaskAttempt({
          taskId: data.taskId,
          attempt: context.attempt,
          outcome: 'succeeded',
        });
        startedAttempts.delete(attemptKey(data.taskId, context.attempt));
        await this.repository.transitionTask({
          taskId: data.taskId,
          to: 'succeeded',
          reason: `Worker ${workerId} completed attempt ${context.attempt}.`,
        });
      },
      onAttemptFailed: async (data, context, error, finalAttempt) => {
        const key = attemptKey(data.taskId, context.attempt);
        if (!startedAttempts.has(key)) {
          return;
        }
        const outcome = classifyFailure(error);
        await this.repository.finishTaskAttempt({
          taskId: data.taskId,
          attempt: context.attempt,
          outcome,
          errorCode: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        startedAttempts.delete(key);
        if (!finalAttempt) {
          return;
        }
        await this.repository.transitionTask({
          taskId: data.taskId,
          to: outcome,
          reason: `Worker ${workerId} exhausted attempt ${context.attempt}.`,
        });
        if (outcome === 'failed' || outcome === 'expired') {
          await this.repository.markTaskDeadLettered(data.taskId);
        }
      },
    });
  }

  public async recoverPending(limit = 100): Promise<{ scanned: number; enqueued: number }> {
    const tasks = await this.repository.listRecoverableTasks(limit);
    let enqueued = 0;
    for (const task of tasks) {
      const result = await this.queue.enqueue(toJobData(task));
      if (!result.deduplicated) {
        enqueued += 1;
      }
    }
    return { scanned: tasks.length, enqueued };
  }

  public async cancel(
    taskId: string,
  ): Promise<'cancelled' | 'cancelling' | 'already_terminal' | 'not_found'> {
    const task = await this.repository.getTask(taskId);
    if (!task) {
      return 'not_found';
    }
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task.status)) {
      return 'already_terminal';
    }
    await this.repository.requestTaskCancellation(taskId);
    const queueResult = await this.queue.cancel(taskId);
    if (queueResult === 'cancelling') {
      return 'cancelling';
    }
    if (task.status === 'queued') {
      await this.repository.transitionTask({
        taskId,
        to: 'cancelled',
        reason: queueResult === 'cancelled' ? 'Cancelled before execution.' : 'Queue job absent.',
      });
      return 'cancelled';
    }
    return queueResult === 'not_found' ? 'cancelling' : queueResult;
  }
}

function readCommand(request: TaskRequest): string | undefined {
  if (request.input.command) {
    return request.input.command;
  }
  const firstToken = request.input.text.trim().split(/\s+/, 1)[0];
  return firstToken?.startsWith('/') ? firstToken : undefined;
}

function classifyFailure(error: unknown): 'failed' | 'cancelled' | 'expired' {
  if (error instanceof TaskCancelledError) {
    return 'cancelled';
  }
  if (error instanceof TaskTimeoutError) {
    return 'expired';
  }
  return 'failed';
}

export function createTaskCoordinator(
  repository: TaskRepository,
  queue: TaskQueueRuntime,
  rules: RouteRule[],
  fallbackExecutor: RouteDecision['executor'] = 'api_agent',
): TaskCoordinator {
  return new TaskCoordinator(repository, queue, rules, fallbackExecutor);
}

function toJobData(task: PersistedTask): TaskJobData {
  if (
    !task.conversationId ||
    !task.executor ||
    !task.routeRuleId ||
    task.routeRuleVersion === undefined
  ) {
    throw new Error(`Persisted task is missing scheduling metadata: ${task.id}`);
  }
  return {
    taskId: task.id,
    correlationId: task.correlationId,
    conversationId: task.conversationId,
    executor: task.executor,
    routeRuleId: task.routeRuleId,
    routeRuleVersion: task.routeRuleVersion,
    enqueuedAt: new Date().toISOString(),
  };
}
