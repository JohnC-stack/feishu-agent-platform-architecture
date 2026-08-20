import { describe, expect, it } from 'vitest';

import { createControlApi } from './app.js';
import type { TaskCoordinator } from './task-coordinator.js';

describe('control-api', () => {
  it('exposes the shared liveness endpoint', async () => {
    const app = createControlApi();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'control-api', status: 'ok' });
  });

  it('returns 400 for an invalid task submission without echoing request values', async () => {
    const app = createControlApi({ coordinator: {} as TaskCoordinator });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { task: 'sensitive-marker', context: 'sensitive-marker' },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    expect(response.body).not.toContain('sensitive-marker');
  });
});
