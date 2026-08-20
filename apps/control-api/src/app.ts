import type { FastifyInstance } from 'fastify';

import { buildServiceApp, type ServiceOptions } from '@feishu-agent/observability';

export const controlApiOptions: ServiceOptions = {
  service: 'control-api',
  version: '0.1.0',
  host: process.env.CONTROL_API_HOST ?? '127.0.0.1',
  port: readPort(process.env.CONTROL_API_PORT, 3000),
  registerRoutes(app) {
    app.get('/', () => ({
      service: 'control-api',
      phase: 'P0',
      message: 'Control plane scaffold is running.',
    }));
  },
};

export function createControlApi(): FastifyInstance {
  return buildServiceApp(controlApiOptions);
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid CONTROL_API_PORT: ${value ?? ''}`);
  }
  return port;
}
