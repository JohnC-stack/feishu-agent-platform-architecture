import Fastify, { type FastifyInstance } from 'fastify';

import type { HealthResponse } from '@feishu-agent/contracts';

export interface ReadinessProbe {
  name: string;
  check(): boolean | Promise<boolean>;
}

export interface ServiceOptions {
  service: string;
  version: string;
  host: string;
  port: number;
  readinessProbes?: readonly ReadinessProbe[];
  registerRoutes?(app: FastifyInstance): void | Promise<void>;
}

export function buildServiceApp(options: ServiceOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'headers.cookie',
          '*.token',
          '*.secret',
          '*.password',
        ],
        censor: '[REDACTED]',
      },
    },
    requestIdHeader: 'x-correlation-id',
  });

  app.get('/health/live', (): HealthResponse => createHealthResponse(options));

  app.get('/health/ready', async (_request, reply) => {
    const checks = await Promise.all(
      (options.readinessProbes ?? []).map(async (probe) => {
        try {
          return { name: probe.name, ok: await probe.check() };
        } catch (error: unknown) {
          return {
            name: probe.name,
            ok: false,
            detail: error instanceof Error ? error.message : 'Unknown readiness failure',
          };
        }
      }),
    );

    const healthy = checks.every(({ ok }) => ok);
    const response = createHealthResponse(options, healthy ? 'ok' : 'degraded', checks);

    return reply.code(healthy ? 200 : 503).send(response);
  });

  if (options.registerRoutes) {
    void app.register(async (scope) => options.registerRoutes?.(scope));
  }

  return app;
}

export async function startService(options: ServiceOptions): Promise<FastifyInstance> {
  const app = buildServiceApp(options);
  await app.listen({ host: options.host, port: options.port });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'service shutdown requested');
    await app.close();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  return app;
}

function createHealthResponse(
  options: ServiceOptions,
  status: HealthResponse['status'] = 'ok',
  checks: HealthResponse['checks'] = [],
): HealthResponse {
  return {
    service: options.service,
    status,
    version: options.version,
    checkedAt: new Date().toISOString(),
    checks,
  };
}
