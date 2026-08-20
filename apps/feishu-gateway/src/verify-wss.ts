import { loadFeishuGatewayConfig } from './config.js';
import { createFeishuConnection } from './connection.js';

async function verify(): Promise<void> {
  const config = loadFeishuGatewayConfig();
  if (!config.enabled) {
    throw new Error('Feishu credentials are not configured.');
  }

  const connection = createFeishuConnection({ config });
  try {
    await connection.start();
    const snapshot = connection.getSnapshot();
    if (snapshot.state !== 'connected') {
      throw new Error(`Unexpected Feishu WSS state: ${snapshot.state}`);
    }
    console.log(
      JSON.stringify({
        configured: snapshot.configured,
        state: snapshot.state,
        reconnectAttempts: snapshot.reconnectAttempts,
        connectedAt: snapshot.connectedAt,
      }),
    );
  } finally {
    await connection.stop();
  }
}

verify().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown Feishu WSS verification failure');
  process.exitCode = 1;
});
