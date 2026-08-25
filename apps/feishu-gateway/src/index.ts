import { createFeishuGateway, createFeishuGatewayOptions } from './app.js';
import {
  ApprovalCardActionProcessor,
  createControlApiApprovalClient,
  createSdkApprovalCardClient,
} from './approval.js';
import { registerApprovalDeliveryRoutes } from './approval-routes.js';
import { loadFeishuGatewayConfig } from './config.js';
import { createFeishuConnection } from './connection.js';
import { loadMessagePipelineConfig } from './pipeline-config.js';
import { FeishuMessageProcessor } from './processor.js';
import { createSdkReplyClient, ReplyDispatcher } from './reply.js';
import { createRedisClient, RedisIdempotencyStore, RedisRateLimiter } from './stores.js';

async function main(): Promise<void> {
  await resolveEnvironmentCredentialReferences({
    names: ['FEISHU_APP_SECRET', 'REDIS_URL'],
    allowedTargetPrefixes: (process.env.CREDENTIAL_TARGET_PREFIXES ?? 'FeishuAgent/')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    allowedFileRoots: (process.env.CREDENTIAL_FILE_ROOTS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    enforceFilePermissions: process.env.CREDENTIAL_FILE_ENFORCE_POSIX_PERMISSIONS !== 'false',
  });
  const config = loadFeishuGatewayConfig();
  const pipelineConfig = loadMessagePipelineConfig();
  const redis = createRedisClient(pipelineConfig.redisUrl);
  await redis.connect();
  if ((await redis.ping()) !== 'PONG') {
    throw new Error('Redis readiness check failed.');
  }

  const idempotency = new RedisIdempotencyStore(redis);
  const approvalCards = createSdkApprovalCardClient(config);
  const approvalProcessor = new ApprovalCardActionProcessor({
    decisions: createControlApiApprovalClient(),
    cards: approvalCards,
    idempotency,
    leaseSeconds: pipelineConfig.eventLeaseSeconds,
    completionTtlSeconds: pipelineConfig.eventDedupTtlSeconds,
  });
  const processor = new FeishuMessageProcessor({
    config: pipelineConfig,
    idempotency,
    rateLimiter: new RedisRateLimiter(redis),
    replies: new ReplyDispatcher({
      client: createSdkReplyClient(config),
      idempotency,
      leaseSeconds: pipelineConfig.eventLeaseSeconds,
      completionTtlSeconds: pipelineConfig.eventDedupTtlSeconds,
      chunkCharacters: pipelineConfig.replyChunkCharacters,
      maxAttempts: pipelineConfig.openApiMaxAttempts,
      retryBaseDelayMs: pipelineConfig.openApiRetryBaseMs,
    }),
  });
  const connection = createFeishuConnection({
    config,
    onMessage: async (event) => {
      await processor.process(event);
    },
    onCardAction: async (event) => {
      const result = await approvalProcessor.process(event);
      return result.card;
    },
  });
  const readinessProbes = [{ name: 'redis', check: async () => (await redis.ping()) === 'PONG' }];
  const options = createFeishuGatewayOptions(connection, readinessProbes);
  const app = createFeishuGateway(connection, readinessProbes);
  app.get('/messages/status', () => processor.getSnapshot());
  app.get('/approvals/status', () => approvalProcessor.getSnapshot());
  registerApprovalDeliveryRoutes(app, approvalCards);
  app.addHook('onClose', async () => {
    if (redis.status === 'ready') {
      await redis.quit();
    } else {
      redis.disconnect();
    }
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'service shutdown requested');
    await app.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: options.host, port: options.port });
  try {
    await connection.start();
    app.log.info(connection.getSnapshot(), 'Feishu WSS startup completed');
  } catch (error: unknown) {
    app.log.error(
      { error: error instanceof Error ? error.message : 'Unknown WSS startup failure' },
      'Feishu WSS startup failed',
    );
    await app.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
import { resolveEnvironmentCredentialReferences } from '@feishu-agent/credentials';
