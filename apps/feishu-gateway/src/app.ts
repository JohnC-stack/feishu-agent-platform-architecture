import type { FastifyInstance } from 'fastify';

import {
  buildServiceApp,
  type ReadinessProbe,
  type ServiceOptions,
} from '@feishu-agent/observability';
import { readServiceTlsOptions } from '@feishu-agent/transport';

import { createDisabledFeishuConnection, type FeishuConnectionRuntime } from './connection.js';

export function createFeishuGatewayOptions(
  connection: FeishuConnectionRuntime,
  additionalReadinessProbes: readonly ReadinessProbe[] = [],
): ServiceOptions {
  return {
    service: 'feishu-gateway',
    version: process.env.PLATFORM_VERSION ?? '0.2.0',
    host: process.env.FEISHU_GATEWAY_HOST ?? '127.0.0.1',
    port: readPort(process.env.FEISHU_GATEWAY_PORT, 3100),
    https: readServiceTlsOptions('FEISHU_GATEWAY'),
    readinessProbes: [
      { name: 'feishu-wss', check: () => connection.isReady() },
      ...additionalReadinessProbes,
    ],
    registerRoutes(app) {
      app.get('/', () => ({
        service: 'feishu-gateway',
        phase: 'P7',
        connection: connection.getSnapshot(),
        message: 'Feishu WSS message and approval callback gateway is available.',
      }));
      app.get('/connection', () => connection.getSnapshot());
    },
  };
}

export function createFeishuGateway(
  connection: FeishuConnectionRuntime = createDisabledFeishuConnection(),
  additionalReadinessProbes: readonly ReadinessProbe[] = [],
): FastifyInstance {
  const app = buildServiceApp(createFeishuGatewayOptions(connection, additionalReadinessProbes));
  app.addHook('onClose', async () => connection.stop());
  return app;
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid FEISHU_GATEWAY_PORT: ${value ?? ''}`);
  }
  return port;
}
