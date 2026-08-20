import { describe, expect, it } from 'vitest';

import { createWindowsWorker } from './app.js';

describe('windows-worker', () => {
  it('uses the shared service health response', async () => {
    const app = createWindowsWorker();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'windows-worker', status: 'ok' });
  });
});
