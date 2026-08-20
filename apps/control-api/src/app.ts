import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { buildServiceApp, type ServiceOptions } from '@feishu-agent/observability';

import { registerTaskRoutes } from './routes.js';
import type { TaskCoordinator } from './task-coordinator.js';

export interface ControlApiDependencies {
  coordinator?: TaskCoordinator;
  readinessProbes?: ServiceOptions['readinessProbes'];
  onClose?(): void | Promise<void>;
}

export const controlApiOptions: ServiceOptions = {
  service: 'control-api',
  version: '0.1.0',
  host: process.env.CONTROL_API_HOST ?? '127.0.0.1',
  port: readPort(process.env.CONTROL_API_PORT, 3000),
  registerRoutes(app) {
    app.get('/', () => ({
      service: 'control-api',
      phase: 'P3',
      message: 'Control plane scheduling and executor dispatch API is running.',
    }));
  },
};

export function createControlApi(dependencies: ControlApiDependencies = {}): FastifyInstance {
  const app = buildServiceApp({
    ...controlApiOptions,
    ...(dependencies.readinessProbes ? { readinessProbes: dependencies.readinessProbes } : {}),
    async registerRoutes(scope) {
      await controlApiOptions.registerRoutes?.(scope);
      if (dependencies.coordinator) {
        registerTaskRoutes(scope, dependencies.coordinator);
      }
    },
  });
  if (dependencies.onClose) {
    app.addHook('onClose', async () => {
      await dependencies.onClose?.();
    });
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn(
        { fields: error.issues.map((issue) => issue.path.join('.')) },
        'request validation failed',
      );
      return reply.code(400).send({
        error: 'invalid_request',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      });
    }
    request.log.error({ error }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });
  return app;
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid CONTROL_API_PORT: ${value ?? ''}`);
  }
  return port;
}
