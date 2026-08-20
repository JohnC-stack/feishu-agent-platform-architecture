import { startService } from '@feishu-agent/observability';

import { windowsWorkerOptions } from './app.js';

startService(windowsWorkerOptions).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
