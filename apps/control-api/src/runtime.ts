import type { RouteRule } from '@feishu-agent/contracts';
import { createDatabaseClient, TaskRepository } from '@feishu-agent/database';

import { createControlApi } from './app.js';
import { createTaskCoordinator } from './task-coordinator.js';
import { readTaskQueueConfig } from './task-queue-config.js';
import { TaskQueueRuntime } from './task-queue.js';

const defaultRouteRules: RouteRule[] = [
  {
    id: 'health-direct',
    version: 1,
    priority: 100,
    enabled: true,
    condition: { commands: ['/health', '/ping'] },
    executor: 'direct_tool',
    description: 'Route health probes to a deterministic direct tool.',
  },
];

export async function createControlApiRuntime() {
  const sql = createDatabaseClient();
  const repository = new TaskRepository(sql);
  let rules = await repository.getActiveRouteRules();
  if (rules.length === 0) {
    await repository.saveRouteRules(defaultRouteRules);
    rules = await repository.getActiveRouteRules();
  }
  const queue = new TaskQueueRuntime(readTaskQueueConfig());
  const coordinator = createTaskCoordinator(repository, queue, rules);
  const recovery = await coordinator.recoverPending();
  const app = createControlApi({
    coordinator,
    readinessProbes: [
      {
        name: 'postgres',
        async check() {
          const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
          return rows[0]?.ok === 1;
        },
      },
      {
        name: 'bullmq',
        async check() {
          await queue.getSnapshot();
          return true;
        },
      },
    ],
    async onClose() {
      await queue.close();
      await sql.end();
    },
  });
  app.log.info(recovery, 'task queue recovery completed');
  return app;
}
