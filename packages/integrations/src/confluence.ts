import { spawn } from 'node:child_process';

import { ExactResourceAllowlist } from './access-control.js';
import { IntegrationError, throwIfIntegrationAborted } from './errors.js';
import { boundIntegrationResult, redactText } from './redaction.js';
import type { BoundedIntegrationResult } from './types.js';

export interface ConfluenceCommandRunner {
  run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown>;
}

export interface LegacyConfluenceSessionRunnerOptions {
  baseUrl: string;
  username: string;
  password: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
  transport?: typeof fetch;
}

export class LegacyConfluenceSessionRunner implements ConfluenceCommandRunner {
  private readonly baseUrl: string;
  private readonly apiRoot: string;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private sessionReady = false;

  public constructor(private readonly options: LegacyConfluenceSessionRunnerOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Confluence base URL must use HTTP(S) without embedded credentials.');
    }
    if (!options.username.trim() || !options.password) {
      throw new Error('Confluence service username and password are required.');
    }
    this.baseUrl = url.toString().replace(/\/$/u, '');
    this.apiRoot = `${this.baseUrl}/rest/api`;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.transport = options.transport ?? fetch;
  }

  public async run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown> {
    throwIfIntegrationAborted(signal);
    const request = parseLegacyRunnerArguments(arguments_);
    return this.requestJson(request.path, request.query, signal);
  }

  private async requestJson(
    path: string,
    query: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.sessionReady) await this.login(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const url = new URL(`${this.apiRoot}/${path}`);
      url.search = query.toString();
      const response = await this.send(url, { method: 'GET', signal });
      const text = await readBoundedResponse(response, this.maxOutputBytes);
      if ((response.status === 401 || looksLikeLogin(response, text)) && attempt === 0) {
        this.sessionReady = false;
        await this.login(signal);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new IntegrationError(
          'unauthorized',
          'CONFLUENCE_ACCESS_DENIED',
          'Confluence denied the service read request.',
          false,
          response.status,
        );
      }
      if (response.status === 429) {
        throw new IntegrationError(
          'rate_limited',
          'CONFLUENCE_RATE_LIMITED',
          'Confluence rate limit was reached.',
          true,
          response.status,
        );
      }
      if (!response.ok) {
        throw new IntegrationError(
          'remote',
          'CONFLUENCE_REQUEST_FAILED',
          `Confluence returned HTTP ${response.status}.`,
          response.status >= 500,
          response.status,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error: unknown) {
        throw new IntegrationError(
          'malformed_response',
          'CONFLUENCE_RESPONSE_MALFORMED',
          'Confluence returned malformed JSON.',
          true,
          response.status,
          { cause: error },
        );
      }
    }
    throw new IntegrationError(
      'unauthorized',
      'CONFLUENCE_ACCESS_DENIED',
      'Confluence session authentication failed.',
      false,
    );
  }

  private async login(signal: AbortSignal): Promise<void> {
    this.cookies.clear();
    const body = new URLSearchParams({
      os_username: this.options.username,
      os_password: this.options.password,
      os_destination: '/rest/api/user/current',
      login: 'Log in',
    });
    const login = await this.send(new URL(`${this.baseUrl}/dologin.action`), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
      signal,
    });
    this.captureCookies(login.headers);
    if (login.status >= 400 || this.cookies.size === 0) {
      throw new IntegrationError(
        'unauthorized',
        'CONFLUENCE_LOGIN_FAILED',
        'Confluence service session login failed.',
        false,
        login.status,
      );
    }
    const check = await this.send(new URL(`${this.apiRoot}/user/current`), {
      method: 'GET',
      signal,
    });
    const text = await readBoundedResponse(check, this.maxOutputBytes);
    if (!check.ok || looksLikeLogin(check, text)) {
      throw new IntegrationError(
        'unauthorized',
        'CONFLUENCE_LOGIN_FAILED',
        'Confluence did not establish an authenticated service session.',
        false,
        check.status,
      );
    }
    try {
      const identity = JSON.parse(text) as Record<string, unknown>;
      if (
        identity.type === 'anonymous' ||
        !['username', 'userKey', 'accountId', 'displayName'].some((key) => identity[key])
      ) {
        throw new Error('Anonymous or unrecognized identity.');
      }
    } catch (error: unknown) {
      throw new IntegrationError(
        'unauthorized',
        'CONFLUENCE_LOGIN_FAILED',
        'Confluence login verification did not return an authenticated identity.',
        false,
        check.status,
        { cause: error },
      );
    }
    this.sessionReady = true;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json,text/html;q=0.5');
    headers.set('user-agent', 'feishu-agent-platform/confluence-service');
    if (this.cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.transport(url, { ...init, headers, signal, redirect: 'manual' });
      this.captureCookies(response.headers);
      return response;
    } catch (error: unknown) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(
        signal.aborted ? 'timeout' : 'dependency',
        signal.aborted ? 'CONFLUENCE_REQUEST_TIMEOUT' : 'CONFLUENCE_CONNECTION_FAILED',
        signal.aborted
          ? `Confluence request exceeded ${this.timeoutMs} ms.`
          : 'Confluence service endpoint could not be reached.',
        true,
        undefined,
        { cause: error },
      );
    }
  }

  private captureCookies(headers: Headers): void {
    const values =
      (headers as Headers & { getSetCookie?(): string[] }).getSetCookie?.() ??
      (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair?.indexOf('=') ?? -1;
      if (pair && separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }
}

interface LegacyConfluenceRequest {
  path: string;
  query: URLSearchParams;
}

function parseLegacyRunnerArguments(arguments_: readonly string[]): LegacyConfluenceRequest {
  if (arguments_.length === 4 && arguments_[0] === 'search' && arguments_[2] === '--limit') {
    const cql = arguments_[1]?.trim() ?? '';
    const limit = Number(arguments_[3]);
    if (!cql || cql.length > 2_000 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw invalidLegacyConfluenceCommand();
    }
    return {
      path: 'content/search',
      query: new URLSearchParams({ cql, limit: String(limit) }),
    };
  }

  if (
    arguments_.length === 5 &&
    arguments_[0] === 'page' &&
    arguments_[1] === 'get' &&
    arguments_[3] === '--expand'
  ) {
    const pageId = arguments_[2] ?? '';
    const expand = arguments_[4] ?? '';
    if (!isSafeConfluenceId(pageId) || !isApprovedExpand(expand)) {
      throw invalidLegacyConfluenceCommand();
    }
    return {
      path: `content/${encodeURIComponent(pageId)}`,
      query: new URLSearchParams({ expand }),
    };
  }

  if (
    arguments_.length === 5 &&
    arguments_[0] === 'api' &&
    arguments_[1] === 'GET' &&
    arguments_[3] === '-q'
  ) {
    const match = /^content\/([A-Za-z0-9_-]+)\/child\/(attachment|comment)$/u.exec(
      arguments_[2] ?? '',
    );
    const query = new URLSearchParams(arguments_[4] ?? '');
    const limit = Number(query.get('limit'));
    if (
      !match ||
      !isSafeConfluenceId(match[1] ?? '') ||
      [...query.keys()].some((key) => key !== 'limit') ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw invalidLegacyConfluenceCommand();
    }
    return {
      path: `content/${encodeURIComponent(match[1] as string)}/child/${match[2] as string}`,
      query: new URLSearchParams({ limit: String(limit) }),
    };
  }

  throw invalidLegacyConfluenceCommand();
}

function invalidLegacyConfluenceCommand(): IntegrationError {
  return new IntegrationError(
    'validation',
    'CONFLUENCE_COMMAND_REJECTED',
    'Confluence service runner rejected an unsupported command.',
    false,
  );
}

function isSafeConfluenceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isApprovedExpand(value: string): boolean {
  return value === 'space' || value === 'body.storage,version,space,ancestors';
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw responseTooLarge(maximumBytes);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw responseTooLarge(maximumBytes);
    }
    chunks.push(value);
  }
  const content = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(content);
}

function responseTooLarge(maximumBytes: number): IntegrationError {
  return new IntegrationError(
    'remote',
    'CONFLUENCE_RESPONSE_TOO_LARGE',
    `Confluence response exceeded ${maximumBytes} bytes.`,
    false,
  );
}

function looksLikeLogin(response: Response, body: string): boolean {
  const location = response.headers.get('location') ?? '';
  if (/login|dologin\.action/iu.test(location)) return true;
  const contentType = response.headers.get('content-type') ?? '';
  return (
    contentType.toLowerCase().includes('text/html') &&
    (/name=["']os_username["']/iu.test(body) || /dologin\.action/iu.test(body))
  );
}

export interface PowerShellConfluenceRunnerOptions {
  wrapperPath: string;
  powershellCommand?: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export class PowerShellConfluenceRunner implements ConfluenceCommandRunner {
  private readonly command: string;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;

  public constructor(private readonly options: PowerShellConfluenceRunnerOptions) {
    if (!options.wrapperPath.trim()) {
      throw new Error('Confluence wrapper path is required.');
    }
    this.command = options.powershellCommand ?? 'powershell.exe';
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown> {
    throwIfIntegrationAborted(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.command,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.options.wrapperPath,
          ...arguments_,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let exceeded = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      const collect =
        (target: Buffer[]) =>
        (chunk: Buffer): void => {
          size += chunk.byteLength;
          if (size > this.maxOutputBytes) {
            exceeded = true;
            child.kill();
            return;
          }
          target.push(chunk);
        };
      child.stdout.on('data', collect(output));
      child.stderr.on('data', collect(errors));
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(
          signal.aborted
            ? new IntegrationError(
                'cancelled',
                'INTEGRATION_CANCELLED',
                'Confluence request was cancelled.',
                false,
              )
            : new IntegrationError(
                'dependency',
                'CONFLUENCE_CLI_START_FAILED',
                'Confluence CLI could not be started.',
                true,
                undefined,
                { cause: error },
              ),
        );
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(
            new IntegrationError(
              'timeout',
              'CONFLUENCE_CLI_TIMEOUT',
              `Confluence CLI exceeded ${this.timeoutMs} ms.`,
              true,
            ),
          );
          return;
        }
        if (exceeded) {
          reject(
            new IntegrationError(
              'remote',
              'CONFLUENCE_RESPONSE_TOO_LARGE',
              `Confluence response exceeded ${this.maxOutputBytes} bytes.`,
              false,
            ),
          );
          return;
        }
        const stdout = Buffer.concat(output).toString('utf8').trim();
        const stderr = redactText(Buffer.concat(errors).toString('utf8').trim()).slice(0, 2_000);
        if (code !== 0) {
          reject(classifyCliError(code, stderr));
          return;
        }
        try {
          resolve(stdout ? (JSON.parse(stdout) as unknown) : null);
        } catch (error: unknown) {
          reject(
            new IntegrationError(
              'malformed_response',
              'CONFLUENCE_RESPONSE_MALFORMED',
              'Confluence CLI returned malformed JSON.',
              true,
              undefined,
              { cause: error },
            ),
          );
        }
      });
    });
  }
}

export interface ConfluenceReadonlyClientOptions {
  runner: ConfluenceCommandRunner;
  allowedSpaceKeys: readonly string[];
  allowedPageIds: readonly string[];
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  maxOutputCharacters?: number;
}

export class ConfluenceReadonlyClient {
  private readonly spaces: ExactResourceAllowlist;
  private readonly pages: ExactResourceAllowlist;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxOutputCharacters: number;

  public constructor(private readonly options: ConfluenceReadonlyClientOptions) {
    this.spaces = new ExactResourceAllowlist(options.allowedSpaceKeys, 'Confluence space');
    this.pages = new ExactResourceAllowlist(options.allowedPageIds, 'Confluence page');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.maxOutputCharacters = options.maxOutputCharacters ?? 20_000;
  }

  public async searchPages(
    spaceKey: string,
    text: string,
    signal: AbortSignal,
    limit = 10,
  ): Promise<BoundedIntegrationResult> {
    const space = this.spaces.assertAllowed(spaceKey);
    const query = text.trim();
    if (!query || query.length > 500) {
      throw new IntegrationError(
        'validation',
        'CONFLUENCE_QUERY_INVALID',
        'Confluence search text must contain 1 to 500 characters.',
        false,
      );
    }
    const boundedLimit = boundedInteger(limit, 1, 50, 'limit');
    const cql = `space='${escapeCql(space)}' AND type=page AND text~'${escapeCql(query)}' order by lastmodified desc`;
    return this.bound(await this.run(['search', cql, '--limit', String(boundedLimit)], signal));
  }

  public async getPage(
    spaceKey: string,
    pageId: string,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const expectedSpace = this.spaces.assertAllowed(spaceKey);
    const page = this.pages.assertAllowed(pageId);
    const result = await this.run(
      ['page', 'get', page, '--expand', 'body.storage,version,space,ancestors'],
      signal,
    );
    assertReturnedSpace(result, expectedSpace);
    return this.bound(result);
  }

  public async listAttachments(
    spaceKey: string,
    pageId: string,
    signal: AbortSignal,
    limit = 25,
  ): Promise<BoundedIntegrationResult> {
    return this.readPageChildren(spaceKey, pageId, 'attachment', signal, limit);
  }

  public async listComments(
    spaceKey: string,
    pageId: string,
    signal: AbortSignal,
    limit = 25,
  ): Promise<BoundedIntegrationResult> {
    return this.readPageChildren(spaceKey, pageId, 'comment', signal, limit);
  }

  private async readPageChildren(
    spaceKey: string,
    pageId: string,
    childType: 'attachment' | 'comment',
    signal: AbortSignal,
    limit: number,
  ): Promise<BoundedIntegrationResult> {
    const expectedSpace = this.spaces.assertAllowed(spaceKey);
    const page = this.pages.assertAllowed(pageId);
    const boundedLimit = boundedInteger(limit, 1, 50, 'limit');
    const pageResult = await this.run(['page', 'get', page, '--expand', 'space'], signal);
    assertReturnedSpace(pageResult, expectedSpace);
    const result = await this.run(
      [
        'api',
        'GET',
        `content/${encodeURIComponent(page)}/child/${childType}`,
        '-q',
        `limit=${boundedLimit}`,
      ],
      signal,
    );
    return this.bound(result);
  }

  private async run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.options.runner.run(arguments_, signal);
      } catch (error: unknown) {
        if (
          !(error instanceof IntegrationError) ||
          !error.retryable ||
          attempt >= this.maxAttempts
        ) {
          throw error;
        }
        await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
    throw new IntegrationError(
      'dependency',
      'CONFLUENCE_RETRY_EXHAUSTED',
      'Confluence request exhausted its retry budget.',
      true,
    );
  }

  private bound(value: unknown): BoundedIntegrationResult {
    return boundIntegrationResult(value, this.maxOutputCharacters);
  }
}

function classifyCliError(code: number | null, stderr: string): IntegrationError {
  const detail = stderr ? ` ${stderr}` : '';
  if (/401|403|unauthori[sz]ed|forbidden|permission/i.test(stderr)) {
    return new IntegrationError(
      'unauthorized',
      'CONFLUENCE_ACCESS_DENIED',
      `Confluence denied the read request.${detail}`,
      false,
    );
  }
  if (/429|rate.?limit|too many requests/i.test(stderr)) {
    return new IntegrationError(
      'rate_limited',
      'CONFLUENCE_RATE_LIMITED',
      `Confluence rate limit was reached.${detail}`,
      true,
    );
  }
  return new IntegrationError(
    'dependency',
    'CONFLUENCE_CLI_FAILED',
    `Confluence CLI exited with code ${code ?? 'unknown'}.${detail}`,
    true,
  );
}

function assertReturnedSpace(value: unknown, expectedSpace: string): void {
  const spaceKey = readNestedString(value, ['space', 'key']);
  if (!spaceKey || spaceKey.toLowerCase() !== expectedSpace.toLowerCase()) {
    throw new IntegrationError(
      'unauthorized',
      'CONFLUENCE_SPACE_MISMATCH',
      'Confluence page did not belong to the approved space.',
      false,
    );
  }
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function escapeCql(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new IntegrationError(
      'validation',
      'CONFLUENCE_PARAMETER_INVALID',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
      false,
    );
  }
  return value;
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
          'Confluence request was cancelled.',
          false,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
