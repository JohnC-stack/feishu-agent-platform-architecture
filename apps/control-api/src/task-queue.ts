import { Queue, QueueEvents, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

import type { ExecutorKind } from '@feishu-agent/contracts';

import type { TaskQueueConfig } from './task-queue-config.js';

const taskJobName = 'execute-task' as const;
const deadLetterJobName = 'dead-letter-task' as const;

export interface TaskJobData {
  taskId: string;
  correlationId: string;
  conversationId: string;
  executor: ExecutorKind;
  routeRuleId: string;
  routeRuleVersion: number;
  enqueuedAt: string;
}

export interface TaskJobResult {
  status: 'succeeded';
  completedAt: string;
  outputReference?: string;
}

export interface DeadLetterJobData extends TaskJobData {
  attemptsMade: number;
  failedAt: string;
  failedReason: string;
}

export interface TaskExecutionContext {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
}

export type TaskHandler = (
  data: TaskJobData,
  context: TaskExecutionContext,
) => Promise<TaskJobResult>;

export interface TaskQueueHooks {
  onAttemptStarted?(data: TaskJobData, context: TaskExecutionContext): void | Promise<void>;
  onAttemptSucceeded?(
    data: TaskJobData,
    context: TaskExecutionContext,
    result: TaskJobResult,
  ): void | Promise<void>;
  onAttemptFailed?(
    data: TaskJobData,
    context: TaskExecutionContext,
    error: unknown,
    finalAttempt: boolean,
  ): void | Promise<void>;
}

export interface TaskQueueSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  deadLettered: number;
}

export class TaskQueueRuntime {
  private readonly queueConnection: IORedis;
  private readonly eventsConnection: IORedis;
  private readonly queue: Queue<TaskJobData, TaskJobResult, typeof taskJobName>;
  private readonly deadLetterQueue: Queue<DeadLetterJobData, void, typeof deadLetterJobName>;
  private readonly events: QueueEvents;
  private readonly activeControllers = new Map<string, AbortController>();
  private workerConnection?: IORedis;
  private worker?: Worker<TaskJobData, TaskJobResult, typeof taskJobName>;

  public constructor(private readonly config: TaskQueueConfig) {
    this.queueConnection = createRedisConnection(config.redisUrl, 1);
    this.eventsConnection = createRedisConnection(config.redisUrl, null);
    this.queue = new Queue(config.queueName, {
      connection: this.queueConnection,
      defaultJobOptions: {
        attempts: config.attempts,
        backoff: { type: 'exponential', delay: config.backoffMs },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 5_000 },
      },
    });
    this.deadLetterQueue = new Queue(`${config.queueName}-dead-letter`, {
      connection: this.queueConnection,
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
    this.events = new QueueEvents(config.queueName, { connection: this.eventsConnection });
  }

  public async startWorker(handler: TaskHandler, hooks: TaskQueueHooks = {}): Promise<void> {
    if (this.worker) {
      return;
    }
    this.workerConnection = createRedisConnection(this.config.redisUrl, null);
    this.worker = new Worker<TaskJobData, TaskJobResult, typeof taskJobName>(
      this.config.queueName,
      async (job) => this.processJob(job, handler, hooks),
      {
        connection: this.workerConnection,
        concurrency: this.config.concurrency,
        lockDuration: this.config.lockDurationMs,
        stalledInterval: this.config.stalledIntervalMs,
        maxStalledCount: this.config.maxStalledCount,
      },
    );
    this.worker.on('error', () => {
      // Runtime health is reported through waitUntilReady and queue metrics; callers own logging.
    });
    await Promise.all([
      this.queue.waitUntilReady(),
      this.deadLetterQueue.waitUntilReady(),
      this.events.waitUntilReady(),
      this.worker.waitUntilReady(),
    ]);
  }

  public async enqueue(data: TaskJobData): Promise<{ jobId: string; deduplicated: boolean }> {
    validateTaskJobData(data);
    const existing = await this.queue.getJob(data.taskId);
    const job = await this.queue.add(taskJobName, data, {
      jobId: data.taskId,
      deduplication: { id: data.taskId },
    });
    if (!job.id) {
      throw new Error('BullMQ returned a task job without an identifier.');
    }
    return { jobId: job.id, deduplicated: Boolean(existing) };
  }

  public async cancel(taskId: string): Promise<'cancelled' | 'cancelling' | 'not_found'> {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.abort(new TaskCancelledError(taskId));
      return 'cancelling';
    }
    const job = await this.queue.getJob(taskId);
    if (!job) {
      return 'not_found';
    }
    const state = await job.getState();
    if (['waiting', 'delayed', 'paused', 'prioritized'].includes(state)) {
      await job.remove();
      return 'cancelled';
    }
    return 'not_found';
  }

  public async waitForResult(
    taskId: string,
    timeoutMs = this.config.timeoutMs * 2,
  ): Promise<TaskJobResult> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      throw new Error(`Task queue job not found: ${taskId}`);
    }
    return job.waitUntilFinished(this.events, timeoutMs);
  }

  public async getSnapshot(): Promise<TaskQueueSnapshot> {
    const [counts, deadLetterCounts] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
      this.deadLetterQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
    ]);
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      deadLettered:
        (deadLetterCounts.waiting ?? 0) +
        (deadLetterCounts.active ?? 0) +
        (deadLetterCounts.delayed ?? 0) +
        (deadLetterCounts.completed ?? 0) +
        (deadLetterCounts.failed ?? 0),
    };
  }

  public async pause(): Promise<void> {
    await this.queue.pause();
  }

  public async resume(): Promise<void> {
    await this.queue.resume();
  }

  public async close(): Promise<void> {
    await this.worker?.close();
    await Promise.all([this.events.close(), this.queue.close(), this.deadLetterQueue.close()]);
    await Promise.all([
      this.workerConnection?.quit(),
      this.eventsConnection.quit(),
      this.queueConnection.quit(),
    ]);
  }

  public async destroyForVerification(): Promise<void> {
    await this.worker?.close(true);
    this.worker = undefined;
    await Promise.all([
      this.queue.obliterate({ force: true }),
      this.deadLetterQueue.obliterate({ force: true }),
    ]);
  }

  private async processJob(
    job: Job<TaskJobData, TaskJobResult, typeof taskJobName>,
    handler: TaskHandler,
    hooks: TaskQueueHooks,
  ): Promise<TaskJobResult> {
    const jobId = job.id;
    if (!jobId) {
      throw new Error('Cannot process a task job without an identifier.');
    }
    const controller = new AbortController();
    const context: TaskExecutionContext = {
      jobId,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
      signal: controller.signal,
    };
    this.activeControllers.set(jobId, controller);
    try {
      await hooks.onAttemptStarted?.(job.data, context);
      const result = await executeWithTimeout(
        () => handler(job.data, context),
        this.config.timeoutMs,
        controller,
      );
      await hooks.onAttemptSucceeded?.(job.data, context, result);
      return result;
    } catch (error: unknown) {
      const attempts = job.opts.attempts ?? 1;
      const cancelled = error instanceof TaskCancelledError;
      const isFinalAttempt = cancelled || job.attemptsMade + 1 >= attempts;
      await hooks.onAttemptFailed?.(job.data, context, error, isFinalAttempt);
      if (isFinalAttempt && !cancelled) {
        const failedReason = error instanceof Error ? error.message : String(error);
        await this.deadLetterQueue.add(
          deadLetterJobName,
          {
            ...job.data,
            attemptsMade: job.attemptsMade + 1,
            failedAt: new Date().toISOString(),
            failedReason: failedReason.slice(0, 2_000),
          },
          { jobId },
        );
      }
      if (cancelled) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    } finally {
      this.activeControllers.delete(jobId);
    }
  }
}

export async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  controller = new AbortController(),
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TaskTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const reason = controller.signal.reason as unknown;
        reject(reason instanceof Error ? reason : new TaskCancelledError('unknown'));
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([operation(), timeout, cancellation]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class TaskTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Task execution timed out after ${timeoutMs} ms.`);
    this.name = 'TaskTimeoutError';
  }
}

export class TaskCancelledError extends Error {
  public constructor(taskId: string) {
    super(`Task execution was cancelled: ${taskId}.`);
    this.name = 'TaskCancelledError';
  }
}

function createRedisConnection(redisUrl: string, maxRetriesPerRequest: number | null): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

function validateTaskJobData(data: TaskJobData): void {
  if (!data.taskId || data.taskId.includes(':')) {
    throw new Error('taskId is required and may not contain a colon.');
  }
  if (!data.correlationId || !data.conversationId || !data.routeRuleId) {
    throw new Error('Task queue data is missing a required identifier.');
  }
  if (!Number.isInteger(data.routeRuleVersion) || data.routeRuleVersion < 1) {
    throw new Error('routeRuleVersion must be a positive integer.');
  }
}
