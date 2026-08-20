import { describe, expect, it } from 'vitest';

import { createFeishuGateway } from './app.js';

describe('feishu-gateway', () => {
  it('exposes the shared readiness endpoint before WSS is configured', async () => {
    const app = createFeishuGateway();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'feishu-gateway', status: 'ok' });
  });
});
