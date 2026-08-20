import { startService } from '@feishu-agent/observability';

import { controlApiOptions } from './app.js';

startService(controlApiOptions).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
