import { randomUUID } from 'node:crypto';

import { loadMessagePipelineConfig } from './pipeline-config.js';
import { createRedisClient, RedisIdempotencyStore, RedisRateLimiter } from './stores.js';

async function verify(): Promise<void> {
  const config = loadMessagePipelineConfig();
  const redis = createRedisClient(config.redisUrl);
  await redis.connect();

  try {
    const id = randomUUID();
    const store = new RedisIdempotencyStore(redis);
    const firstLease = await store.begin('verification', id, 30);
    const duplicateLease = await store.begin('verification', id, 30);
    const completed = firstLease ? await store.complete(firstLease, 30) : false;
    const completedDuplicate = await store.begin('verification', id, 30);

    const limiter = new RedisRateLimiter(redis);
    const firstRate = await limiter.consume(`verification:${id}`, 1, 30);
    const secondRate = await limiter.consume(`verification:${id}`, 1, 30);

    const result = {
      redis: (await redis.ping()) === 'PONG',
      firstLease: Boolean(firstLease),
      concurrentDuplicateBlocked: duplicateLease === null,
      completionPersisted: completed && completedDuplicate === null,
      firstRateAllowed: firstRate.allowed,
      secondRateBlocked: !secondRate.allowed,
    };
    if (Object.values(result).some((value) => !value)) {
      throw new Error(`Pipeline verification failed: ${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify(result));
  } finally {
    await redis.quit();
  }
}

verify().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown pipeline verification failure');
  process.exitCode = 1;
});
