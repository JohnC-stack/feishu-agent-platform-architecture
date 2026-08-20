import type { FastifyInstance } from 'fastify';

import { buildServiceApp, type ServiceOptions } from '@feishu-agent/observability';

export const windowsWorkerOptions: ServiceOptions = {
  service: 'windows-worker',
  version: '0.1.0',
  host: process.env.WINDOWS_WORKER_HOST ?? '127.0.0.1',
  port: readPort(process.env.WINDOWS_WORKER_PORT, 3200),
  registerRoutes(app) {
    app.get('/', () => ({
      service: 'windows-worker',
      phase: 'P0',
      executors: ['direct_tool', 'api_agent', 'agent_cli'],
      message: 'Executor protocol is ready; concrete adapters start in P3.',
    }));
  },
};

export function createWindowsWorker(): FastifyInstance {
  return buildServiceApp(windowsWorkerOptions);
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid WINDOWS_WORKER_PORT: ${value ?? ''}`);
  }
  return port;
}
