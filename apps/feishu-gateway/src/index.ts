import { startService } from '@feishu-agent/observability';

import { feishuGatewayOptions } from './app.js';

startService(feishuGatewayOptions).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
