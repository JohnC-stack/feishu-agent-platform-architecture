export interface TaskQueueConfig {
  redisUrl: string;
  queueName: string;
  concurrency: number;
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  lockDurationMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
}

export function readTaskQueueConfig(environment: NodeJS.ProcessEnv = process.env): TaskQueueConfig {
  const queueName = environment.TASK_QUEUE_NAME ?? 'feishu-agent-tasks';
  if (!/^[a-zA-Z0-9_-]+$/.test(queueName)) {
    throw new Error('TASK_QUEUE_NAME may contain only letters, digits, underscores, and hyphens.');
  }
  return {
    redisUrl: readRedisUrl(environment.REDIS_URL),
    queueName,
    concurrency: readInteger(environment.TASK_QUEUE_CONCURRENCY, 4, 1, 100),
    timeoutMs: readInteger(environment.TASK_QUEUE_TIMEOUT_MS, 300_000, 100, 86_400_000),
    attempts: readInteger(environment.TASK_QUEUE_ATTEMPTS, 3, 1, 20),
    backoffMs: readInteger(environment.TASK_QUEUE_BACKOFF_MS, 1_000, 1, 3_600_000),
    lockDurationMs: readInteger(environment.TASK_QUEUE_LOCK_DURATION_MS, 30_000, 1_000, 3_600_000),
    stalledIntervalMs: readInteger(
      environment.TASK_QUEUE_STALLED_INTERVAL_MS,
      30_000,
      1_000,
      3_600_000,
    ),
    maxStalledCount: readInteger(environment.TASK_QUEUE_MAX_STALLED_COUNT, 1, 0, 10),
  };
}

function readRedisUrl(value: string | undefined): string {
  const redisUrl = value ?? 'redis://127.0.0.1:6379';
  const parsed = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    throw new Error('REDIS_URL must use redis:// or rediss://.');
  }
  return redisUrl;
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}; received ${value}.`);
  }
  return parsed;
}
