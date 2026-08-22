import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

const TokenResponseSchema = z
  .object({
    code: z.number().optional(),
    access_token: z.string().min(1).optional(),
  })
  .passthrough();

const UserInfoResponseSchema = z
  .object({
    code: z.number(),
    data: z
      .object({
        open_id: z.string().min(1),
        union_id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        en_name: z.string().min(1).optional(),
        avatar_url: z.string().url().optional(),
      })
      .optional(),
  })
  .passthrough();

export interface FeishuOAuthConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  frontendUrl?: string;
  scopes?: string[];
  stateTtlMs?: number;
  sessionTtlMs?: number;
  requestTimeoutMs?: number;
}

export interface FeishuOAuthUser {
  openId: string;
  unionId?: string;
  name: string;
  avatarUrl?: string;
}

export type FeishuOAuthLoginMode = 'standard' | 'super_admin';

export interface FeishuOAuthAuthorization {
  user: FeishuOAuthUser;
  mode: FeishuOAuthLoginMode;
}

export interface FeishuOAuthPublicConfig {
  enabled: boolean;
  redirectUri?: string;
}

interface AuthorizationState {
  codeVerifier: string;
  expiresAt: number;
  mode: FeishuOAuthLoginMode;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const authorizeEndpoint = 'https://open.feishu.cn/open-apis/authen/v1/authorize';
const tokenEndpoint = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const userInfoEndpoint = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const defaultStateTtlMs = 5 * 60 * 1_000;
const defaultSessionTtlMs = 8 * 60 * 60 * 1_000;
const defaultRequestTimeoutMs = 10_000;
const maxPendingStates = 128;

export class FeishuOAuthError extends Error {
  public constructor(
    public readonly code:
      | 'FEISHU_OAUTH_DISABLED'
      | 'FEISHU_OAUTH_INVALID_STATE'
      | 'FEISHU_OAUTH_ACCESS_DENIED'
      | 'FEISHU_OAUTH_TOKEN_EXCHANGE_FAILED'
      | 'FEISHU_OAUTH_USER_INFO_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'FeishuOAuthError';
  }
}

export class FeishuOAuthService {
  private readonly pendingStates = new Map<string, AuthorizationState>();

  public constructor(
    private readonly config: FeishuOAuthConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {
    validateConfig(config);
  }

  public getPublicConfig(): FeishuOAuthPublicConfig {
    return {
      enabled: this.config.enabled,
      ...(this.config.enabled && this.config.redirectUri
        ? { redirectUri: this.config.redirectUri }
        : {}),
    };
  }

  public getSessionTtlMs(): number {
    return this.config.sessionTtlMs ?? defaultSessionTtlMs;
  }

  public beginAuthorization(mode: FeishuOAuthLoginMode = 'standard'): string {
    const configured = this.requireEnabledConfig();
    this.prunePendingStates();
    if (this.pendingStates.size >= maxPendingStates) {
      const oldest = this.pendingStates.keys().next().value;
      if (oldest) this.pendingStates.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    const { codeVerifier, codeChallenge } = createPkcePair();
    this.pendingStates.set(state, {
      codeVerifier,
      expiresAt: Date.now() + (this.config.stateTtlMs ?? defaultStateTtlMs),
      mode,
    });
    const url = new URL(authorizeEndpoint);
    url.searchParams.set('client_id', configured.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', configured.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    const scopes = [...new Set(this.config.scopes ?? [])].filter(Boolean);
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    return url.toString();
  }

  public rejectAuthorization(state: string): never {
    this.takeState(state);
    throw new FeishuOAuthError('FEISHU_OAUTH_ACCESS_DENIED', '用户取消了飞书授权。');
  }

  public async completeAuthorization(input: {
    code: string;
    state: string;
  }): Promise<FeishuOAuthAuthorization> {
    const configured = this.requireEnabledConfig();
    const authorizationState = this.takeState(input.state);
    const accessToken = await this.exchangeCode({
      clientId: configured.clientId,
      clientSecret: configured.clientSecret,
      redirectUri: configured.redirectUri,
      code: input.code,
      codeVerifier: authorizationState.codeVerifier,
    });
    return { user: await this.fetchUserInfo(accessToken), mode: authorizationState.mode };
  }

  public successRedirectUrl(mode: FeishuOAuthLoginMode = 'standard'): string {
    return buildFrontendRedirect(
      this.requireEnabledConfig().frontendUrl,
      'auth',
      mode === 'super_admin' ? 'feishu-super-admin' : 'feishu',
      'overview',
    );
  }

  public errorRedirectUrl(code: string, hash = 'overview'): string {
    return buildFrontendRedirect(this.requireEnabledConfig().frontendUrl, 'auth_error', code, hash);
  }

  private async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<string> {
    try {
      const response = await this.fetcher(tokenEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? defaultRequestTimeoutMs),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      const parsed = TokenResponseSchema.safeParse(payload);
      if (
        response.ok &&
        parsed.success &&
        (parsed.data.code === undefined || parsed.data.code === 0) &&
        parsed.data.access_token
      ) {
        return parsed.data.access_token;
      }
      reportOAuthDiagnostic('token_exchange_rejected', response.status, payload);
      throw new FeishuOAuthError(
        'FEISHU_OAUTH_TOKEN_EXCHANGE_FAILED',
        '飞书登录凭证交换失败，请重新发起登录。',
      );
    } catch (error: unknown) {
      if (error instanceof FeishuOAuthError) throw error;
      reportOAuthDiagnostic('token_exchange_transport_failed', undefined, error);
      throw new FeishuOAuthError(
        'FEISHU_OAUTH_TOKEN_EXCHANGE_FAILED',
        '飞书登录凭证交换失败，请重新发起登录。',
      );
    }
  }

  private async fetchUserInfo(accessToken: string): Promise<FeishuOAuthUser> {
    try {
      const response = await this.fetcher(userInfoEndpoint, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? defaultRequestTimeoutMs),
      });
      const body = UserInfoResponseSchema.parse(await response.json());
      if (!response.ok || body.code !== 0 || !body.data) {
        throw new Error('Feishu user info endpoint rejected the access token.');
      }
      return {
        openId: body.data.open_id,
        ...(body.data.union_id ? { unionId: body.data.union_id } : {}),
        name: body.data.name ?? body.data.en_name ?? '飞书用户',
        ...(body.data.avatar_url ? { avatarUrl: body.data.avatar_url } : {}),
      };
    } catch {
      throw new FeishuOAuthError(
        'FEISHU_OAUTH_USER_INFO_FAILED',
        '无法读取飞书登录用户信息，请重新登录。',
      );
    }
  }

  private takeState(state: string): AuthorizationState {
    const authorizationState = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!authorizationState || authorizationState.expiresAt <= Date.now()) {
      throw new FeishuOAuthError(
        'FEISHU_OAUTH_INVALID_STATE',
        '飞书登录状态已过期或不匹配，请重新登录。',
      );
    }
    return authorizationState;
  }

  private prunePendingStates(): void {
    const now = Date.now();
    for (const [state, item] of this.pendingStates) {
      if (item.expiresAt <= now) this.pendingStates.delete(state);
    }
  }

  private requireEnabledConfig(): Required<
    Pick<FeishuOAuthConfig, 'clientId' | 'clientSecret' | 'redirectUri' | 'frontendUrl'>
  > {
    if (
      !this.config.enabled ||
      !this.config.clientId ||
      !this.config.clientSecret ||
      !this.config.redirectUri ||
      !this.config.frontendUrl
    ) {
      throw new FeishuOAuthError('FEISHU_OAUTH_DISABLED', '飞书登录尚未启用。');
    }
    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      frontendUrl: this.config.frontendUrl,
    };
  }
}

export function readFeishuOAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FeishuOAuthConfig {
  const enabled = readBoolean(environment.FEISHU_OAUTH_ENABLED, false, 'FEISHU_OAUTH_ENABLED');
  const redirectUri = environment.FEISHU_OAUTH_REDIRECT_URI?.trim();
  const frontendUrl =
    environment.FEISHU_OAUTH_FRONTEND_URL?.trim() ||
    (redirectUri ? `${new URL(redirectUri).origin}/` : undefined);
  return {
    enabled,
    clientId: environment.FEISHU_APP_ID?.trim(),
    clientSecret: environment.FEISHU_APP_SECRET?.trim(),
    redirectUri,
    frontendUrl,
    scopes: readScopes(environment.FEISHU_OAUTH_SCOPES),
    sessionTtlMs: readPositiveInteger(
      environment.FEISHU_OAUTH_SESSION_TTL_MS,
      defaultSessionTtlMs,
      'FEISHU_OAUTH_SESSION_TTL_MS',
    ),
    requestTimeoutMs: readPositiveInteger(
      environment.FEISHU_OAUTH_REQUEST_TIMEOUT_MS,
      defaultRequestTimeoutMs,
      'FEISHU_OAUTH_REQUEST_TIMEOUT_MS',
    ),
  };
}

function validateConfig(config: FeishuOAuthConfig): void {
  if (!config.enabled) return;
  if (!config.clientId?.trim() || !config.clientSecret?.trim() || !config.redirectUri) {
    throw new Error(
      'FEISHU_OAUTH_ENABLED requires FEISHU_APP_ID, FEISHU_APP_SECRET, and FEISHU_OAUTH_REDIRECT_URI.',
    );
  }
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== 'https:' && !isLoopbackHostname(redirect.hostname)) {
    throw new Error('FEISHU_OAUTH_REDIRECT_URI must use HTTPS unless it targets loopback.');
  }
  const frontend = new URL(config.frontendUrl ?? `${redirect.origin}/`);
  if (frontend.protocol !== 'https:' && !isLoopbackHostname(frontend.hostname)) {
    throw new Error('FEISHU_OAUTH_FRONTEND_URL must use HTTPS unless it targets loopback.');
  }
}

function buildFrontendRedirect(
  frontendUrl: string,
  key: string,
  value: string,
  hash: string,
): string {
  const url = new URL(frontendUrl);
  url.searchParams.set(key, value);
  url.hash = hash;
  return url.toString();
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readScopes(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(/[\s,]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

export function createPkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  return { codeVerifier, codeChallenge: createPkceChallenge(codeVerifier) };
}

function reportOAuthDiagnostic(event: string, httpStatus?: number, detail?: unknown): void {
  const record = isRecord(detail) ? detail : undefined;
  const responseCode = record?.code ?? record?.error;
  const responseMessage = record?.msg ?? record?.error_description;
  console.error(
    JSON.stringify({
      event: `feishu_oauth_${event}`,
      ...(httpStatus ? { httpStatus } : {}),
      ...(typeof responseCode === 'string' || typeof responseCode === 'number'
        ? { responseCode }
        : {}),
      ...(typeof responseMessage === 'string'
        ? { responseMessage: responseMessage.slice(0, 300) }
        : {}),
      ...(!record && detail instanceof Error ? { errorName: detail.name } : {}),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
