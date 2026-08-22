import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServiceApp } from './index.js';

const apps: ReturnType<typeof buildServiceApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('service health protocol', () => {
  it('reports liveness without checking dependencies', async () => {
    const app = buildServiceApp({
      service: 'test-service',
      version: '0.1.0',
      host: '127.0.0.1',
      port: 0,
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'test-service', status: 'ok' });
  });

  it('returns 503 when a readiness dependency is unavailable', async () => {
    const app = buildServiceApp({
      service: 'test-service',
      version: '0.1.0',
      host: '127.0.0.1',
      port: 0,
      readinessProbes: [{ name: 'database', check: () => false }],
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: [{ name: 'database', ok: false }],
    });
  });

  it('redacts callback query strings from automatic request logs', async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const app = buildServiceApp({
      service: 'test-service',
      version: '0.1.0',
      host: '127.0.0.1',
      port: 0,
    });
    apps.push(app);

    try {
      await app.inject({
        method: 'GET',
        url: '/health/live?code=one-time-code&state=oauth-state',
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      writeSpy.mockRestore();
    }

    const output = writes.join('');
    expect(output).not.toContain('one-time-code');
    expect(output).not.toContain('oauth-state');
    expect(output).toContain('[REDACTED]');
  });
});
