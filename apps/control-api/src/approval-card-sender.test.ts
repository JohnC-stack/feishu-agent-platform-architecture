import { describe, expect, it } from 'vitest';

import { createFeishuGatewayApprovalCardSender } from './approval-card-sender.js';

describe('P5 approval card sender', () => {
  it('refuses non-loopback gateway destinations', () => {
    expect(() => createFeishuGatewayApprovalCardSender('https://example.com')).toThrow('loopback');
  });
});
