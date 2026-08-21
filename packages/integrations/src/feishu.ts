import { ExactResourceAllowlist } from './access-control.js';
import { IntegrationError, throwIfIntegrationAborted } from './errors.js';
import { RetryingHttpClient, type RetryingHttpClientOptions } from './http-client.js';
import { boundIntegrationResult, redactText } from './redaction.js';
import type { BoundedIntegrationResult } from './types.js';

export interface FeishuReadonlyClientOptions {
  appId: string;
  appSecret: string;
  allowedDocumentIds: readonly string[];
  allowedBitableAppTokens: readonly string[];
  allowedChatIds: readonly string[];
  allowedUserIds: readonly string[];
  baseUrl?: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  maxOutputCharacters?: number;
  http?: Omit<RetryingHttpClientOptions, 'baseUrl' | 'defaultHeaders'>;
}

export class FeishuReadonlyClient {
  private readonly documents: ExactResourceAllowlist;
  private readonly bitables: ExactResourceAllowlist;
  private readonly chats: ExactResourceAllowlist;
  private readonly users: ExactResourceAllowlist;
  private readonly http: RetryingHttpClient;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxOutputCharacters: number;
  private cachedToken?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  public constructor(private readonly options: FeishuReadonlyClientOptions) {
    if (!options.appId.trim() || !options.appSecret.trim()) {
      throw new Error('Feishu App ID and App Secret are required.');
    }
    this.documents = new ExactResourceAllowlist(options.allowedDocumentIds, 'Feishu document');
    this.bitables = new ExactResourceAllowlist(
      options.allowedBitableAppTokens,
      'Feishu bitable app',
    );
    this.chats = new ExactResourceAllowlist(options.allowedChatIds, 'Feishu chat');
    this.users = new ExactResourceAllowlist(options.allowedUserIds, 'Feishu user');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.maxOutputCharacters = options.maxOutputCharacters ?? 20_000;
    this.http = new RetryingHttpClient({
      ...options.http,
      baseUrl: options.baseUrl ?? 'https://open.feishu.cn/open-apis/',
    });
  }

  public async getDocument(
    documentId: string,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const document = this.documents.assertAllowed(documentId);
    const [metadata, blocks] = await Promise.all([
      this.callOpenApi(`docx/v1/documents/${encodeURIComponent(document)}`, {}, signal),
      this.callOpenApi(
        `docx/v1/documents/${encodeURIComponent(document)}/blocks`,
        { page_size: 100 },
        signal,
      ),
    ]);
    return this.bound({ metadata, blocks });
  }

  public async getBitable(
    appToken: string,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const token = this.bitables.assertAllowed(appToken);
    const [app, tables] = await Promise.all([
      this.callOpenApi(`bitable/v1/apps/${encodeURIComponent(token)}`, {}, signal),
      this.callOpenApi(
        `bitable/v1/apps/${encodeURIComponent(token)}/tables`,
        { page_size: 100 },
        signal,
      ),
    ]);
    return this.bound({ app, tables });
  }

  public async getChat(chatId: string, signal: AbortSignal): Promise<BoundedIntegrationResult> {
    const chat = this.chats.assertAllowed(chatId);
    return this.bound(
      await this.callOpenApi(`im/v1/chats/${encodeURIComponent(chat)}`, {}, signal),
    );
  }

  public async getUser(userId: string, signal: AbortSignal): Promise<BoundedIntegrationResult> {
    const user = this.users.assertAllowed(userId);
    return this.bound(
      await this.callOpenApi(
        `contact/v3/users/${encodeURIComponent(user)}`,
        { user_id_type: inferUserIdType(user), department_id_type: 'open_department_id' },
        signal,
      ),
    );
  }

  private async callOpenApi(
    path: string,
    query: Readonly<Record<string, string | number | boolean | undefined>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const tenantToken = await this.getTenantAccessToken(signal);
      const response = await this.http.request(
        path,
        {
          headers: { authorization: `Bearer ${tenantToken}` },
          query,
          acceptNon2xx: true,
        },
        signal,
      );
      const body = asRecord(response.data);
      const code = typeof body.code === 'number' ? body.code : undefined;
      if (code === 0) {
        return body.data ?? {};
      }
      const error = feishuBusinessError(code, body.msg);
      if (!error.retryable || attempt >= this.maxAttempts) {
        throw error;
      }
      await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), signal);
    }
    throw new IntegrationError(
      'dependency',
      'FEISHU_RETRY_EXHAUSTED',
      'Feishu request exhausted its retry budget.',
      true,
    );
  }

  private async getTenantAccessToken(signal: AbortSignal): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }
    this.pendingToken ??= this.requestTenantAccessToken(signal).finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async requestTenantAccessToken(signal: AbortSignal): Promise<string> {
    const response = await this.http.request(
      'auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        body: { app_id: this.options.appId, app_secret: this.options.appSecret },
      },
      signal,
    );
    const body = asRecord(response.data);
    const code = typeof body.code === 'number' ? body.code : undefined;
    if (code !== 0) {
      throw feishuBusinessError(code, body.msg);
    }
    const token = typeof body.tenant_access_token === 'string' ? body.tenant_access_token : '';
    const expiresIn = typeof body.expire === 'number' ? body.expire : 7_200;
    if (!token) {
      throw new IntegrationError(
        'malformed_response',
        'FEISHU_TOKEN_MISSING',
        'Feishu token response did not contain a tenant access token.',
        true,
      );
    }
    this.cachedToken = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  private bound(value: unknown): BoundedIntegrationResult {
    return boundIntegrationResult(value, this.maxOutputCharacters);
  }
}

function feishuBusinessError(code: number | undefined, rawMessage: unknown): IntegrationError {
  const message = typeof rawMessage === 'string' ? redactText(rawMessage).slice(0, 1_000) : '';
  const detail = message ? ` ${message}` : '';
  if (code === 99991400 || /rate.?limit|too many request/i.test(message)) {
    return new IntegrationError(
      'rate_limited',
      'FEISHU_RATE_LIMITED',
      `Feishu rate limit was reached (code ${code ?? 'unknown'}).${detail}`,
      true,
    );
  }
  if (
    code === 99991663 ||
    code === 99991672 ||
    code === 1770032 ||
    /permission|forbidden|unauthori[sz]ed/i.test(message)
  ) {
    return new IntegrationError(
      'unauthorized',
      'FEISHU_ACCESS_DENIED',
      `Feishu denied the read request (code ${code ?? 'unknown'}).${detail}`,
      false,
    );
  }
  return new IntegrationError(
    'remote',
    'FEISHU_BUSINESS_ERROR',
    `Feishu returned business error ${code ?? 'unknown'}.${detail}`,
    false,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationError(
      'malformed_response',
      'FEISHU_RESPONSE_MALFORMED',
      'Feishu returned a malformed response body.',
      true,
    );
  }
  return value as Record<string, unknown>;
}

function inferUserIdType(value: string): 'open_id' | 'union_id' | 'user_id' {
  if (value.startsWith('ou_')) {
    return 'open_id';
  }
  if (value.startsWith('on_')) {
    return 'union_id';
  }
  return 'user_id';
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfIntegrationAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(
        new IntegrationError(
          'cancelled',
          'INTEGRATION_CANCELLED',
          'Feishu request was cancelled.',
          false,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
