import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ApprovalCardClient } from './approval.js';

const ApprovalCardDeliverySchema = z
  .object({
    approvalId: z.string().uuid(),
    chatId: z.string().min(1).max(500),
    card: z.record(z.string(), z.unknown()),
  })
  .strict();

export function registerApprovalDeliveryRoutes(
  app: FastifyInstance,
  cards: ApprovalCardClient,
): void {
  app.post('/internal/approvals/cards', async (request, reply) => {
    const parsed = ApprovalCardDeliverySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_approval_card_delivery' });
    }
    const input = parsed.data;
    const result = await cards.send(input.chatId, input.card);
    return reply.code(201).send({
      approvalId: input.approvalId,
      messageId: result.messageId,
    });
  });
}
