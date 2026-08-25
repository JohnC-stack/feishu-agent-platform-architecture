import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@feishu-agent/contracts': workspaceSource('contracts'),
      '@feishu-agent/credentials': workspaceSource('credentials'),
      '@feishu-agent/database': workspaceSource('database'),
      '@feishu-agent/executors': workspaceSource('executors'),
      '@feishu-agent/integrations': workspaceSource('integrations'),
      '@feishu-agent/observability': workspaceSource('observability'),
      '@feishu-agent/policy': workspaceSource('policy'),
      '@feishu-agent/testing': workspaceSource('testing'),
      '@feishu-agent/transport': workspaceSource('transport'),
    },
  },
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    passWithNoTests: false,
  },
});

function workspaceSource(packageName: string): string {
  return fileURLToPath(new URL(`./packages/${packageName}/src/index.ts`, import.meta.url));
}
