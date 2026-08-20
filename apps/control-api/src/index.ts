import { createControlApiRuntime } from './runtime.js';

createControlApiRuntime()
  .then(async (app) => {
    await app.listen({
      host: process.env.CONTROL_API_HOST ?? '127.0.0.1',
      port: readPort(process.env.CONTROL_API_PORT, 3000),
    });
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      app.log.info({ signal }, 'service shutdown requested');
      await app.close();
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid CONTROL_API_PORT: ${value ?? ''}`);
  }
  return port;
}
