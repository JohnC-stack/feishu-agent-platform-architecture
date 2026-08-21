import type { ApprovalCardSender } from './governance-service.js';

export function createFeishuGatewayApprovalCardSender(
  baseUrlInput = process.env.FEISHU_GATEWAY_INTERNAL_URL ?? 'http://127.0.0.1:3100',
): ApprovalCardSender {
  const baseUrl = new URL(baseUrlInput);
  if (!['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) {
    throw new Error('FEISHU_GATEWAY_INTERNAL_URL must resolve to the local loopback interface.');
  }
  return {
    async send(input) {
      const response = await fetch(new URL('/internal/approvals/cards', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as { messageId?: string; error?: string };
      if (!response.ok || !body.messageId) {
        throw new Error(
          `Feishu approval card delivery failed: ${response.status}/${body.error ?? ''}`,
        );
      }
      return { messageId: body.messageId };
    },
  };
}
