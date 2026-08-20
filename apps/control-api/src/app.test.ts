import { describe, expect, it } from 'vitest';

import { createControlApi } from './app.js';

describe('control-api', () => {
  it('exposes the shared liveness endpoint', async () => {
    const app = createControlApi();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'control-api', status: 'ok' });
  });
});
