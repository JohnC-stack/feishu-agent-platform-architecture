import type { ServerOptions } from 'node:https';

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
  https?: ServerOptions;
  readinessProbes?: readonly ReadinessProbe[];
  registerRoutes?(app: FastifyInstance): void | Promise<void>;
}

export function buildServiceApp(options: ServiceOptions): FastifyInstance {
  const requestMetrics = new Map<string, { count: number; durationSeconds: number }>();
  const startedAtSeconds = Date.now() / 1_000;
  const fastifyOptions = {
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.url',
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
  };
  const app = (options.https
    ? Fastify({ ...fastifyOptions, https: options.https })
    : Fastify(fastifyOptions)) as unknown as FastifyInstance;

  app.get('/health/live', (): HealthResponse => createHealthResponse(options));

  app.get('/metrics', (_request, reply) => {
    const memory = process.memoryUsage();
    const labels = `service="${escapePrometheusLabel(options.service)}",version="${escapePrometheusLabel(options.version)}"`;
    const lines = [
      '# HELP feishu_agent_service_info Static service build information.',
      '# TYPE feishu_agent_service_info gauge',
      `feishu_agent_service_info{${labels}} 1`,
      '# HELP feishu_agent_process_start_time_seconds Process start time as Unix seconds.',
      '# TYPE feishu_agent_process_start_time_seconds gauge',
      `feishu_agent_process_start_time_seconds{service="${escapePrometheusLabel(options.service)}"} ${startedAtSeconds}`,
      '# HELP feishu_agent_process_resident_memory_bytes Resident process memory.',
      '# TYPE feishu_agent_process_resident_memory_bytes gauge',
      `feishu_agent_process_resident_memory_bytes{service="${escapePrometheusLabel(options.service)}"} ${memory.rss}`,
      '# HELP feishu_agent_process_heap_used_bytes Used V8 heap memory.',
      '# TYPE feishu_agent_process_heap_used_bytes gauge',
      `feishu_agent_process_heap_used_bytes{service="${escapePrometheusLabel(options.service)}"} ${memory.heapUsed}`,
      '# HELP feishu_agent_http_requests_total Completed HTTP requests.',
      '# TYPE feishu_agent_http_requests_total counter',
      '# HELP feishu_agent_http_request_duration_seconds_total Cumulative HTTP request duration.',
      '# TYPE feishu_agent_http_request_duration_seconds_total counter',
    ];
    for (const [key, metric] of [...requestMetrics].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const [method, route, status] = key.split('\u0000');
      const metricLabels = `service="${escapePrometheusLabel(options.service)}",method="${escapePrometheusLabel(method ?? 'UNKNOWN')}",route="${escapePrometheusLabel(route ?? 'unknown')}",status="${escapePrometheusLabel(status ?? '0')}"`;
      lines.push(`feishu_agent_http_requests_total{${metricLabels}} ${metric.count}`);
      lines.push(
        `feishu_agent_http_request_duration_seconds_total{${metricLabels}} ${metric.durationSeconds}`,
      );
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route !== '/metrics') {
      const key = [request.method, route, String(reply.statusCode)].join('\u0000');
      const metric = requestMetrics.get(key) ?? { count: 0, durationSeconds: 0 };
      metric.count += 1;
      metric.durationSeconds += reply.elapsedTime / 1_000;
      requestMetrics.set(key, metric);
    }
    done();
  });

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

function escapePrometheusLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
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
