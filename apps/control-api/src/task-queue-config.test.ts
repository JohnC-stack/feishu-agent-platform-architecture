import { describe, expect, it } from 'vitest';

import { readTaskQueueConfig } from './task-queue-config.js';

describe('readTaskQueueConfig', () => {
  it('applies bounded scheduling defaults', () => {
    expect(readTaskQueueConfig({})).toMatchObject({
      queueName: 'feishu-agent-tasks',
      concurrency: 4,
      attempts: 3,
      timeoutMs: 300_000,
    });
  });

  it('rejects unsafe queue names and unbounded concurrency', () => {
    expect(() => readTaskQueueConfig({ TASK_QUEUE_NAME: 'tasks:unsafe' })).toThrow(
      'TASK_QUEUE_NAME',
    );
    expect(() => readTaskQueueConfig({ TASK_QUEUE_CONCURRENCY: '101' })).toThrow(
      'between 1 and 100',
    );
  });
});
