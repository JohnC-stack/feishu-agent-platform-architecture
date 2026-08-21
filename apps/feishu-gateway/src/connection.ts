import {
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type EventHandles,
  type WSConnectionState,
  type WSConnectionStatus,
} from '@larksuiteoapi/node-sdk';

import type { FeishuGatewayConfig } from './config.js';

export type FeishuMessageEvent = Parameters<NonNullable<EventHandles['im.message.receive_v1']>>[0];
export interface FeishuCardActionEvent {
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  operator?: { open_id?: string; user_id?: string; union_id?: string; name?: string };
  action?: { value?: unknown; tag?: string; name?: string; option?: string };
}
export type FeishuCardActionResponse = Record<string, unknown>;

export type GatewayConnectionState = 'disabled' | WSConnectionState;

export interface FeishuConnectionSnapshot {
  configured: boolean;
  state: GatewayConnectionState;
  reconnectAttempts: number;
  connectedAt?: string;
  lastError?: string;
}

export interface FeishuConnectionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  getSnapshot(): FeishuConnectionSnapshot;
}

export interface WsLifecycleCallbacks {
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

export interface WsClientLike {
  start(params: { eventDispatcher: EventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus(): WSConnectionStatus;
}

export type WsClientFactory = (
  config: FeishuGatewayConfig,
  callbacks: WsLifecycleCallbacks,
) => WsClientLike;

export interface FeishuConnectionOptions {
  config: FeishuGatewayConfig;
  onMessage?(event: FeishuMessageEvent): void | Promise<void>;
  onCardAction?(
    event: FeishuCardActionEvent,
  ): FeishuCardActionResponse | void | Promise<FeishuCardActionResponse | void>;
  clientFactory?: WsClientFactory;
}

export function createFeishuConnection(options: FeishuConnectionOptions): FeishuConnectionRuntime {
  const messageHandler = async (event: FeishuMessageEvent): Promise<void> => {
    await options.onMessage?.(event);
  };
  return new ManagedFeishuConnection(
    options.config,
    messageHandler,
    async (event) => options.onCardAction?.(event),
    options.clientFactory ?? createSdkClient,
  );
}

export function createDisabledFeishuConnection(): FeishuConnectionRuntime {
  const snapshot: FeishuConnectionSnapshot = {
    configured: false,
    state: 'disabled',
    reconnectAttempts: 0,
  };
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    isReady: () => true,
    getSnapshot: () => ({ ...snapshot }),
  };
}

class ManagedFeishuConnection implements FeishuConnectionRuntime {
  private client?: WsClientLike;
  private state: GatewayConnectionState;
  private connectedAt?: string;
  private lastError?: string;
  private settleStart?: { resolve(): void; reject(error: Error): void };

  public constructor(
    private readonly config: FeishuGatewayConfig,
    private readonly onMessage: (event: FeishuMessageEvent) => void | Promise<void>,
    private readonly onCardAction: (
      event: FeishuCardActionEvent,
    ) => FeishuCardActionResponse | void | Promise<FeishuCardActionResponse | void>,
    private readonly clientFactory: WsClientFactory,
  ) {
    this.state = config.enabled ? 'idle' : 'disabled';
  }

  public async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (
      this.state === 'connected' ||
      this.state === 'connecting' ||
      this.state === 'reconnecting'
    ) {
      return;
    }

    this.state = 'connecting';
    this.lastError = undefined;

    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.info }).register({
      'im.message.receive_v1': async (event) => {
        await this.onMessage(event);
      },
    });
    const registerCardCallback = dispatcher.register.bind(dispatcher) as unknown as (handles: {
      'card.action.trigger': (
        event: FeishuCardActionEvent,
      ) => Promise<FeishuCardActionResponse | void>;
    }) => EventDispatcher;
    registerCardCallback({
      'card.action.trigger': async (event) => {
        return this.onCardAction(event);
      },
    });

    const connected = new Promise<void>((resolve, reject) => {
      this.settleStart = { resolve, reject };
    });

    this.client = this.clientFactory(this.config, {
      onReady: () => this.markConnected(),
      onError: (error) => this.markFailed(error),
      onReconnecting: () => {
        this.state = 'reconnecting';
      },
      onReconnected: () => this.markConnected(),
    });

    await this.client.start({ eventDispatcher: dispatcher });

    const timer = setTimeout(() => {
      const error = new Error(
        `Feishu WSS did not connect within ${this.config.connectTimeoutMs} ms.`,
      );
      this.client?.close({ force: true });
      this.markFailed(error);
    }, this.config.connectTimeoutMs);

    try {
      await connected;
    } finally {
      clearTimeout(timer);
      this.settleStart = undefined;
    }
  }

  public stop(): Promise<void> {
    this.client?.close({ force: false });
    this.client = undefined;
    this.state = this.config.enabled ? 'idle' : 'disabled';
    this.connectedAt = undefined;
    this.settleStart = undefined;
    return Promise.resolve();
  }

  public isReady(): boolean {
    return !this.config.enabled || this.state === 'connected';
  }

  public getSnapshot(): FeishuConnectionSnapshot {
    const sdkStatus = this.client?.getConnectionStatus();
    return {
      configured: this.config.enabled,
      state: this.state,
      reconnectAttempts: sdkStatus?.reconnectAttempts ?? 0,
      ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private markConnected(): void {
    this.state = 'connected';
    this.connectedAt = new Date().toISOString();
    this.lastError = undefined;
    this.settleStart?.resolve();
  }

  private markFailed(error: Error): void {
    this.state = 'failed';
    this.lastError = error.message;
    this.settleStart?.reject(error);
  }
}

function createSdkClient(
  this: void,
  config: FeishuGatewayConfig,
  callbacks: WsLifecycleCallbacks,
): WsClientLike {
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu credentials are required to create a WSS client.');
  }

  return new WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Domain.Feishu,
    autoReconnect: true,
    source: 'feishu-agent-platform',
    loggerLevel: LoggerLevel.info,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    wsConfig: { pingTimeout: config.pingTimeoutSeconds },
    ...callbacks,
  });
}
