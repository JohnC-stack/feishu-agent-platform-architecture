import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const queueName = process.env.P2_VERIFY_QUEUE_NAME;
if (!queueName) {
  throw new Error('P2_VERIFY_QUEUE_NAME is required.');
}
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});
const worker = new Worker(
  queueName,
  async () => {
    process.stdout.write('P2_WORKER_ACTIVE\n');
    return new Promise<never>(() => undefined);
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 1_000,
    stalledInterval: 1_000,
    maxStalledCount: 1,
  },
);

await worker.waitUntilReady();
