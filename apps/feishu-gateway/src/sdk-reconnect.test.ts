import type { AddressInfo } from 'node:net';

import { EventDispatcher, LoggerLevel, WSClient, type HttpInstance } from '@larksuiteoapi/node-sdk';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';

describe('official Feishu SDK reconnect behavior', () => {
  it('reconnects after a live WebSocket is forcibly disconnected', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    let connectionCount = 0;

    server.on('connection', (socket) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        setTimeout(() => socket.terminate(), 50);
      }
    });

    const ready = deferred();
    const reconnected = deferred();
    let reconnectingCount = 0;
    const httpInstance = {
      request: () =>
        Promise.resolve({
          code: 0,
          msg: 'ok',
          data: {
            URL: `ws://127.0.0.1:${port}/?device_id=test-device&service_id=1`,
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
              ReconnectInterval: 0.01,
              ReconnectNonce: 0,
            },
          },
        }),
    } as unknown as HttpInstance;

    const client = new WSClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'test-secret',
      domain: 'http://127.0.0.1',
      httpInstance,
      autoReconnect: true,
      loggerLevel: LoggerLevel.error,
      handshakeTimeoutMs: 1000,
      onReady: () => ready.resolve(),
      onReconnecting: () => {
        reconnectingCount += 1;
      },
      onReconnected: () => reconnected.resolve(),
      onError: (error) => {
        ready.reject(error);
        reconnected.reject(error);
      },
    });

    try {
      await client.start({
        eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.error }),
      });
      await withTimeout(ready.promise, 2000, 'initial SDK connection');
      await withTimeout(reconnected.promise, 2000, 'SDK reconnect');

      expect(connectionCount).toBeGreaterThanOrEqual(2);
      expect(reconnectingCount).toBeGreaterThanOrEqual(1);
      expect(client.getConnectionStatus()).toMatchObject({
        state: 'connected',
        reconnectAttempts: 0,
      });
    } finally {
      client.close({ force: true });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
