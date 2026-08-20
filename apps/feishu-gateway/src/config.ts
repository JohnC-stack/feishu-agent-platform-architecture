export interface FeishuGatewayConfig {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  pingTimeoutSeconds: number;
}

export function loadFeishuGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FeishuGatewayConfig {
  const appId = environment.FEISHU_APP_ID?.trim();
  const appSecret = environment.FEISHU_APP_SECRET?.trim();

  if (Boolean(appId) !== Boolean(appSecret)) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured together.');
  }

  if (!appId || !appSecret) {
    return {
      enabled: false,
      connectTimeoutMs: readPositiveInteger(
        environment.FEISHU_WSS_CONNECT_TIMEOUT_MS,
        30_000,
        'FEISHU_WSS_CONNECT_TIMEOUT_MS',
      ),
      handshakeTimeoutMs: readPositiveInteger(
        environment.FEISHU_WSS_HANDSHAKE_TIMEOUT_MS,
        10_000,
        'FEISHU_WSS_HANDSHAKE_TIMEOUT_MS',
      ),
      pingTimeoutSeconds: readPositiveInteger(
        environment.FEISHU_WSS_PING_TIMEOUT_SECONDS,
        10,
        'FEISHU_WSS_PING_TIMEOUT_SECONDS',
      ),
    };
  }

  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error('FEISHU_APP_ID must match the enterprise self-built app ID format.');
  }

  return {
    enabled: true,
    appId,
    appSecret,
    connectTimeoutMs: readPositiveInteger(
      environment.FEISHU_WSS_CONNECT_TIMEOUT_MS,
      30_000,
      'FEISHU_WSS_CONNECT_TIMEOUT_MS',
    ),
    handshakeTimeoutMs: readPositiveInteger(
      environment.FEISHU_WSS_HANDSHAKE_TIMEOUT_MS,
      10_000,
      'FEISHU_WSS_HANDSHAKE_TIMEOUT_MS',
    ),
    pingTimeoutSeconds: readPositiveInteger(
      environment.FEISHU_WSS_PING_TIMEOUT_SECONDS,
      10,
      'FEISHU_WSS_PING_TIMEOUT_SECONDS',
    ),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
