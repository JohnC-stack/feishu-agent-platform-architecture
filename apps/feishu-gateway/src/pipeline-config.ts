export interface MessagePipelineConfig {
  redisUrl: string;
  eventLeaseSeconds: number;
  eventDedupTtlSeconds: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  replyChunkCharacters: number;
  openApiMaxAttempts: number;
  openApiRetryBaseMs: number;
}

export function loadMessagePipelineConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MessagePipelineConfig {
  return {
    redisUrl: environment.REDIS_URL?.trim() || 'redis://127.0.0.1:6379',
    eventLeaseSeconds: readPositiveInteger(
      environment.FEISHU_EVENT_LEASE_SECONDS,
      60,
      'FEISHU_EVENT_LEASE_SECONDS',
    ),
    eventDedupTtlSeconds: readPositiveInteger(
      environment.FEISHU_EVENT_DEDUP_TTL_SECONDS,
      86_400,
      'FEISHU_EVENT_DEDUP_TTL_SECONDS',
    ),
    rateLimitMax: readPositiveInteger(
      environment.FEISHU_RATE_LIMIT_MAX,
      20,
      'FEISHU_RATE_LIMIT_MAX',
    ),
    rateLimitWindowSeconds: readPositiveInteger(
      environment.FEISHU_RATE_LIMIT_WINDOW_SECONDS,
      60,
      'FEISHU_RATE_LIMIT_WINDOW_SECONDS',
    ),
    replyChunkCharacters: readPositiveInteger(
      environment.FEISHU_REPLY_CHUNK_CHARACTERS,
      4000,
      'FEISHU_REPLY_CHUNK_CHARACTERS',
    ),
    openApiMaxAttempts: readPositiveInteger(
      environment.FEISHU_OPENAPI_MAX_ATTEMPTS,
      3,
      'FEISHU_OPENAPI_MAX_ATTEMPTS',
    ),
    openApiRetryBaseMs: readPositiveInteger(
      environment.FEISHU_OPENAPI_RETRY_BASE_MS,
      250,
      'FEISHU_OPENAPI_RETRY_BASE_MS',
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
