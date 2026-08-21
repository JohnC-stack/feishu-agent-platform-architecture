import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';

import { ExecutorExecutionRequestSchema } from '@feishu-agent/contracts';
import { buildServiceApp, type ServiceOptions } from '@feishu-agent/observability';

import { createWindowsWorkerRuntime, type WindowsWorkerRuntime } from './runtime.js';

const TaskIdParametersSchema = z.object({ taskId: z.string().uuid() });

export interface WindowsWorkerDependencies {
  runtime?: WindowsWorkerRuntime;
}

export const windowsWorkerOptions: ServiceOptions = {
  service: 'windows-worker',
  version: '0.1.0',
  host: process.env.WINDOWS_WORKER_HOST ?? '127.0.0.1',
  port: readPort(process.env.WINDOWS_WORKER_PORT, 3200),
};

export function createWindowsWorker(dependencies: WindowsWorkerDependencies = {}): FastifyInstance {
  const runtime = dependencies.runtime ?? createWindowsWorkerRuntime();
  const app = buildServiceApp({
    ...windowsWorkerOptions,
    readinessProbes: [
      { name: 'codex_cli', check: () => runtime.status.codexCliAvailable },
      ...(runtime.status.apiAgentEnabled
        ? [{ name: 'api_agent', check: () => runtime.status.apiAgentConfigured }]
        : []),
    ],
    registerRoutes(scope) {
      scope.get('/', () => ({
        service: 'windows-worker',
        phase: 'P4',
        executors: [
          'direct_tool',
          ...(runtime.status.apiAgentEnabled ? ['api_agent'] : []),
          'agent_cli',
        ],
        activeExecutions: runtime.executionService.activeCount(),
        capabilities: runtime.status,
      }));
      scope.post('/v1/executions', async (request) => {
        const execution = ExecutorExecutionRequestSchema.parse(request.body);
        return runtime.executionService.execute(execution);
      });
      scope.post('/v1/executions/:taskId/cancel', (request, reply) => {
        const { taskId } = TaskIdParametersSchema.parse(request.params);
        const cancelled = runtime.executionService.cancel(taskId);
        return reply.code(cancelled ? 202 : 404).send({ taskId, cancelled });
      });
    },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn(
        { fields: error.issues.map((issue) => issue.path.join('.')) },
        'worker request validation failed',
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
    request.log.error({ error }, 'worker request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });
  return app;
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid WINDOWS_WORKER_PORT: ${value ?? ''}`);
  }
  return port;
}
