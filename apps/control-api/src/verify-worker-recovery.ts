import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const queueName = `p2-recovery-${randomUUID().replaceAll('-', '')}`;
const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
const eventsConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection: queueConnection });
const events = new QueueEvents(queueName, { connection: eventsConnection });
const job = await queue.add(
  'recovery-test',
  { taskId: randomUUID() },
  { attempts: 2, removeOnComplete: false, removeOnFail: false },
);
let recoveryWorker: Worker | undefined;
let recoveryConnection: IORedis | undefined;
let child: ReturnType<typeof spawn> | undefined;

try {
  await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
  child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./verify-stalled-worker-child.ts', import.meta.url)),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, REDIS_URL: redisUrl, P2_VERIFY_QUEUE_NAME: queueName },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await waitForMarker(child, 'P2_WORKER_ACTIVE', 10_000);
  const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
  if (!child.kill('SIGKILL')) {
    throw new Error('Synthetic worker process could not be terminated.');
  }
  await exited;

  let stalledEvents = 0;
  events.on('stalled', () => {
    stalledEvents += 1;
  });
  recoveryConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  recoveryWorker = new Worker(
    queueName,
    () => Promise.resolve({ recovered: true, recoveredAt: new Date().toISOString() }),
    {
      connection: recoveryConnection,
      concurrency: 1,
      lockDuration: 1_000,
      stalledInterval: 1_000,
      maxStalledCount: 1,
    },
  );
  await recoveryWorker.waitUntilReady();
  const result = (await job.waitUntilFinished(events, 15_000)) as { recovered?: boolean };
  const state = await job.getState();
  const verification = {
    childExited: child.exitCode !== null || child.signalCode !== null,
    stalledDetected: stalledEvents >= 1,
    recovered: result.recovered === true,
    finalStateCompleted: state === 'completed',
  };
  if (Object.values(verification).some((passed) => !passed)) {
    throw new Error(`P2 worker recovery verification failed: ${JSON.stringify(verification)}`);
  }
  console.log(JSON.stringify(verification));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
  }
  await recoveryWorker?.close(true);
  await recoveryConnection?.quit();
  await queue.obliterate({ force: true });
  await Promise.all([events.close(), queue.close()]);
  await Promise.all([eventsConnection.quit(), queueConnection.quit()]);
}

async function waitForMarker(
  process: ReturnType<typeof spawn>,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child worker marker: ${marker}`));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      process.stdout?.removeAllListeners();
      process.stderr?.removeAllListeners();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    process.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes(marker)) {
        finish();
      }
    });
    process.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        finish(new Error(`Child worker failed before activation: ${message}`));
      }
    });
    process.once('exit', (code) => {
      finish(new Error(`Child worker exited before activation with code ${code}.`));
    });
  });
}
