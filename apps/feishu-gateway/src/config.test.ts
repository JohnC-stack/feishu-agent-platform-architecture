import { describe, expect, it } from 'vitest';

import { loadFeishuGatewayConfig } from './config.js';

describe('loadFeishuGatewayConfig', () => {
  it('keeps the gateway disabled when both credentials are absent', () => {
    expect(loadFeishuGatewayConfig({})).toMatchObject({
      enabled: false,
      connectTimeoutMs: 30_000,
    });
  });

  it('rejects partial credentials', () => {
    expect(() => loadFeishuGatewayConfig({ FEISHU_APP_ID: 'cli_0123456789abcdef' })).toThrow(
      'must be configured together',
    );
  });

  it('loads a valid enterprise self-built app configuration', () => {
    const config = loadFeishuGatewayConfig({
      FEISHU_APP_ID: 'cli_0123456789abcdef',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_WSS_CONNECT_TIMEOUT_MS: '5000',
    });

    expect(config).toMatchObject({
      enabled: true,
      appId: 'cli_0123456789abcdef',
      connectTimeoutMs: 5000,
    });
  });
});
