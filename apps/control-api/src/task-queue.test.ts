import { describe, expect, it } from 'vitest';

import { executeWithTimeout, TaskTimeoutError } from './task-queue.js';

describe('executeWithTimeout', () => {
  it('returns a result completed inside the deadline', async () => {
    await expect(executeWithTimeout(() => Promise.resolve('ok'), 100)).resolves.toBe('ok');
  });

  it('aborts and rejects an operation that exceeds the deadline', async () => {
    const controller = new AbortController();
    await expect(
      executeWithTimeout(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 50)),
        5,
        controller,
      ),
    ).rejects.toBeInstanceOf(TaskTimeoutError);
    expect(controller.signal.aborted).toBe(true);
  });
});
