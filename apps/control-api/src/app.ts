import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { buildServiceApp, type ServiceOptions } from '@feishu-agent/observability';
import { BudgetExceededError, GovernanceConflictError } from '@feishu-agent/database';
import { readServiceTlsOptions } from '@feishu-agent/transport';

import { registerGovernanceRoutes } from './governance-routes.js';
import { AdminAuthenticationError, registerAdminRoutes } from './admin-routes.js';
import { AdminValidationError, type AdminService } from './admin-service.js';
import type { FeishuOAuthService } from './feishu-oauth-service.js';
import { GovernanceAuthorizationError, type GovernanceService } from './governance-service.js';
import { registerTaskRoutes } from './routes.js';
import type { TaskCoordinator } from './task-coordinator.js';

export interface ControlApiDependencies {
  coordinator?: TaskCoordinator;
  governance?: GovernanceService;
  admin?: AdminService;
  feishuOAuth?: FeishuOAuthService;
  readinessProbes?: ServiceOptions['readinessProbes'];
  onClose?(): void | Promise<void>;
}

export const controlApiOptions: ServiceOptions = {
  service: 'control-api',
  version: process.env.PLATFORM_VERSION ?? '0.1.0',
  host: process.env.CONTROL_API_HOST ?? '127.0.0.1',
  port: readPort(process.env.CONTROL_API_PORT, 3000),
  https: readServiceTlsOptions('CONTROL_API'),
  registerRoutes(app) {
    app.get('/', () => ({
      service: 'control-api',
      phase: 'P7',
      message: 'Governed scheduling, approval, observability, and operations API is running.',
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
        registerTaskRoutes(scope, dependencies.coordinator, dependencies.governance);
      }
      if (dependencies.governance) {
        registerGovernanceRoutes(scope, dependencies.governance);
      }
      if (dependencies.admin) {
        registerAdminRoutes(scope, dependencies.admin, dependencies.feishuOAuth);
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
    if (error instanceof AdminAuthenticationError) {
      return reply.code(401).send({ error: error.code, message: error.message });
    }
    if (error instanceof GovernanceAuthorizationError) {
      return reply.code(403).send({ error: error.code, message: error.message });
    }
    if (error instanceof BudgetExceededError) {
      return reply.code(429).send({
        error: 'BUDGET_EXCEEDED',
        message: error.message,
        violations: error.violations,
      });
    }
    if (error instanceof GovernanceConflictError) {
      return reply.code(409).send({ error: error.code, message: error.message });
    }
    if (error instanceof AdminValidationError) {
      return reply.code(400).send({ error: 'invalid_admin_operation', message: error.message });
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
