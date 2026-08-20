import { randomUUID } from 'node:crypto';

import type { TaskJobData } from './task-queue.js';
import { TaskQueueRuntime } from './task-queue.js';

const suffix = randomUUID().replaceAll('-', '');
const runtime = new TaskQueueRuntime({
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queueName: `p2-verify-${suffix}`,
  concurrency: 2,
  timeoutMs: 80,
  attempts: 2,
  backoffMs: 10,
  lockDurationMs: 1_000,
  stalledIntervalMs: 1_000,
  maxStalledCount: 1,
});
const attemptCounts = new Map<string, number>();
let active = 0;
let maximumActive = 0;

function createJob(taskId: string): TaskJobData {
  return {
    taskId,
    correlationId: `correlation-${taskId}`,
    conversationId: `conversation-${taskId}`,
    executor: 'direct_tool',
    routeRuleId: 'verify-direct',
    routeRuleVersion: 1,
    enqueuedAt: new Date().toISOString(),
  };
}

const retryTask = randomUUID();
const timeoutTask = randomUUID();
const concurrentTasks = [randomUUID(), randomUUID()];
const cancelledTask = randomUUID();

try {
  await runtime.startWorker(async (data, context) => {
    const attempt = (attemptCounts.get(data.taskId) ?? 0) + 1;
    attemptCounts.set(data.taskId, attempt);
    if (data.taskId === retryTask && context.attempt === 1) {
      throw new Error('Synthetic retryable failure.');
    }
    if (data.taskId === timeoutTask) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { status: 'succeeded', completedAt: new Date().toISOString() };
    }
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: 'succeeded', completedAt: new Date().toISOString() };
    } finally {
      active -= 1;
    }
  });

  const firstEnqueue = await runtime.enqueue(createJob(retryTask));
  const duplicateEnqueue = await runtime.enqueue(createJob(retryTask));
  await Promise.all(concurrentTasks.map((taskId) => runtime.enqueue(createJob(taskId))));
  await runtime.enqueue(createJob(timeoutTask));
  await runtime.pause();
  await runtime.enqueue(createJob(cancelledTask));
  const cancelResult = await runtime.cancel(cancelledTask);
  await runtime.resume();

  await Promise.all([
    runtime.waitForResult(retryTask, 5_000),
    ...concurrentTasks.map((taskId) => runtime.waitForResult(taskId, 5_000)),
  ]);
  let timeoutFailed = false;
  try {
    await runtime.waitForResult(timeoutTask, 5_000);
  } catch {
    timeoutFailed = true;
  }
  const snapshot = await runtime.getSnapshot();
  const result = {
    deduplicated:
      !firstEnqueue.deduplicated &&
      duplicateEnqueue.deduplicated &&
      firstEnqueue.jobId === duplicateEnqueue.jobId,
    retrySucceeded: attemptCounts.get(retryTask) === 2,
    concurrencyReached: maximumActive === 2,
    timeoutFailed,
    deadLettered: snapshot.deadLettered === 1,
    cancellation: cancelResult === 'cancelled',
  };
  if (Object.values(result).some((passed) => !passed)) {
    throw new Error(`P2 queue verification failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await runtime.destroyForVerification();
  await runtime.close();
}
