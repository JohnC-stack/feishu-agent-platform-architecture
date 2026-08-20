import { describe, expect, it } from 'vitest';

import type {
  EventDispatcher,
  WSConnectionState,
  WSConnectionStatus,
} from '@larksuiteoapi/node-sdk';

import type { FeishuGatewayConfig } from './config.js';
import {
  createFeishuConnection,
  type FeishuMessageEvent,
  type WsClientFactory,
  type WsClientLike,
  type WsLifecycleCallbacks,
} from './connection.js';

const config: FeishuGatewayConfig = {
  enabled: true,
  appId: 'cli_0123456789abcdef',
  appSecret: 'test-secret',
  connectTimeoutMs: 1000,
  handshakeTimeoutMs: 1000,
  pingTimeoutSeconds: 10,
};

class FakeWsClient implements WsClientLike {
  public state: WSConnectionState = 'idle';
  public closed = false;
  public dispatcher?: EventDispatcher;

  public constructor(private readonly callbacks: WsLifecycleCallbacks) {}

  public start(params: { eventDispatcher: EventDispatcher }): Promise<void> {
    this.dispatcher = params.eventDispatcher;
    this.state = 'connected';
    this.callbacks.onReady();
    return Promise.resolve();
  }

  public close(): void {
    this.closed = true;
    this.state = 'idle';
  }

  public getConnectionStatus(): WSConnectionStatus {
    return { state: this.state, reconnectAttempts: 0 };
  }

  public reconnect(): void {
    this.state = 'reconnecting';
    this.callbacks.onReconnecting();
    this.state = 'connected';
    this.callbacks.onReconnected();
  }
}

describe('managed Feishu WSS connection', () => {
  it('reports connected readiness and closes cleanly', async () => {
    let fakeClient: FakeWsClient | undefined;
    const factory: WsClientFactory = (_config, callbacks) => {
      fakeClient = new FakeWsClient(callbacks);
      return fakeClient;
    };

    const connection = createFeishuConnection({ config, clientFactory: factory });
    await connection.start();

    expect(connection.isReady()).toBe(true);
    expect(connection.getSnapshot()).toMatchObject({
      configured: true,
      state: 'connected',
      reconnectAttempts: 0,
    });

    fakeClient?.reconnect();
    expect(connection.getSnapshot().state).toBe('connected');

    await connection.stop();
    expect(fakeClient?.closed).toBe(true);
    expect(connection.getSnapshot().state).toBe('idle');
  });

  it('keeps message handling injectable without exposing credentials', async () => {
    const received: FeishuMessageEvent[] = [];
    const factory: WsClientFactory = (_config, callbacks) => new FakeWsClient(callbacks);
    const connection = createFeishuConnection({
      config,
      clientFactory: factory,
      onMessage: (event) => {
        received.push(event);
      },
    });

    await connection.start();
    expect(received).toEqual([]);
    expect(JSON.stringify(connection.getSnapshot())).not.toContain('test-secret');
    await connection.stop();
  });

  it('dispatches the Feishu v2 message-event contract through the SDK dispatcher', async () => {
    let fakeClient: FakeWsClient | undefined;
    const received: FeishuMessageEvent[] = [];
    const connection = createFeishuConnection({
      config,
      clientFactory: (_config, callbacks) => {
        fakeClient = new FakeWsClient(callbacks);
        return fakeClient;
      },
      onMessage: (event) => {
        received.push(event);
      },
    });

    await connection.start();
    await fakeClient?.dispatcher?.invoke(
      {
        schema: '2.0',
        header: { event_id: 'event-contract', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
          message: {
            message_id: 'message-contract',
            create_time: '1787220000000',
            chat_id: 'chat-contract',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: '/ping' }),
          },
        },
      },
      { needCheck: false },
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event_id: 'event-contract',
      message: { message_id: 'message-contract' },
    });
    await connection.stop();
  });

  it('fails closed when the initial WSS handshake never becomes ready', async () => {
    let closed = false;
    const factory: WsClientFactory = () => ({
      start: () => Promise.resolve(),
      close: () => {
        closed = true;
      },
      getConnectionStatus: () => ({ state: 'connecting', reconnectAttempts: 0 }),
    });
    const connection = createFeishuConnection({
      config: { ...config, connectTimeoutMs: 5 },
      clientFactory: factory,
    });

    await expect(connection.start()).rejects.toThrow('did not connect within 5 ms');
    expect(closed).toBe(true);
    expect(connection.getSnapshot()).toMatchObject({ state: 'failed' });
  });
});
