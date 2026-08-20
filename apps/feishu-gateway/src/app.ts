import type { FastifyInstance } from 'fastify';

import { buildServiceApp, type ServiceOptions } from '@feishu-agent/observability';

export const feishuGatewayOptions: ServiceOptions = {
  service: 'feishu-gateway',
  version: '0.1.0',
  host: process.env.FEISHU_GATEWAY_HOST ?? '127.0.0.1',
  port: readPort(process.env.FEISHU_GATEWAY_PORT, 3100),
  registerRoutes(app) {
    app.get('/', () => ({
      service: 'feishu-gateway',
      phase: 'P0',
      connection: 'not-configured',
      message: 'WSS integration starts in P1.',
    }));
  },
};

export function createFeishuGateway(): FastifyInstance {
  return buildServiceApp(feishuGatewayOptions);
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid FEISHU_GATEWAY_PORT: ${value ?? ''}`);
  }
  return port;
}
