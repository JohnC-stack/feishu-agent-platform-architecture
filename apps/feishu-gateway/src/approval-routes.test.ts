import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerApprovalDeliveryRoutes } from './approval-routes.js';

describe('P5 approval card delivery route', () => {
  it('validates and sends an approval card through the Feishu client', async () => {
    const send = vi.fn(() => Promise.resolve({ messageId: 'om_p5_delivery' }));
    const app = Fastify();
    registerApprovalDeliveryRoutes(app, {
      send,
      update: () => Promise.resolve(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/approvals/cards',
      payload: {
        approvalId: '0aeb29c6-541d-4f73-805e-9bf09e2d9f76',
        chatId: 'oc_p5',
        card: { config: { wide_screen_mode: true }, elements: [] },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ messageId: 'om_p5_delivery' });
    expect(send).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects malformed approval identifiers before sending', async () => {
    const send = vi.fn();
    const app = Fastify();
    registerApprovalDeliveryRoutes(app, {
      send,
      update: () => Promise.resolve(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/approvals/cards',
      payload: { approvalId: 'invalid', chatId: 'oc_p5', card: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    await app.close();
  });
});
