import { RouteChatTypeSchema, TaskRequestSchema } from '@feishu-agent/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { TaskCoordinator } from './task-coordinator.js';

const TaskSubmissionSchema = z.object({
  task: TaskRequestSchema,
  context: z.object({ chatType: RouteChatTypeSchema }).strict(),
});

const TaskIdParametersSchema = z.object({
  taskId: z.string().uuid(),
});

export function registerTaskRoutes(app: FastifyInstance, coordinator: TaskCoordinator): void {
  app.post('/v1/tasks', async (request, reply) => {
    const submission = TaskSubmissionSchema.parse(request.body);
    const result = await coordinator.submit(submission.task, submission.context);
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.get('/v1/tasks/:taskId', async (request, reply) => {
    const { taskId } = TaskIdParametersSchema.parse(request.params);
    const task = await coordinator.getTask(taskId);
    return task ? reply.send(task) : reply.code(404).send({ error: 'task_not_found' });
  });

  app.post('/v1/tasks/:taskId/cancel', async (request, reply) => {
    const { taskId } = TaskIdParametersSchema.parse(request.params);
    const status = await coordinator.cancel(taskId);
    return status === 'not_found'
      ? reply.code(404).send({ error: 'task_not_found' })
      : reply.send({ taskId, status });
  });
}
