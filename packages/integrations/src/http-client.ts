import { IntegrationError, throwIfIntegrationAborted } from './errors.js';
import { redactText } from './redaction.js';

export interface RetryingHttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  maxAttempts?: number;
  timeoutMs?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  responseType?: 'json' | 'text';
  acceptNon2xx?: boolean;
}

export interface IntegrationHttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

export class RetryingHttpClient {
  private readonly baseUrl: URL;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: RetryingHttpClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl);
    this.maxAttempts = readInteger(options.maxAttempts, 3, 1, 10, 'maxAttempts');
    this.timeoutMs = readInteger(options.timeoutMs, 10_000, 50, 300_000, 'timeoutMs');
    this.retryBaseDelayMs = readInteger(
      options.retryBaseDelayMs,
      250,
      0,
      60_000,
      'retryBaseDelayMs',
    );
    this.maxRetryDelayMs = readInteger(
      options.maxRetryDelayMs,
      5_000,
      0,
      300_000,
      'maxRetryDelayMs',
    );
    this.maxResponseBytes = readInteger(
      options.maxResponseBytes,
      1_000_000,
      1_024,
      100_000_000,
      'maxResponseBytes',
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async request<T = unknown>(
    path: string,
    request: HttpRequestOptions,
    signal: AbortSignal,
  ): Promise<IntegrationHttpResponse<T>> {
    const url = this.createUrl(path, request.query);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfIntegrationAborted(signal);
      try {
        const response = await this.fetchAttempt(url, request, signal);
        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
            await response.body?.cancel();
            await delay(this.retryDelay(attempt, response.headers), signal);
            continue;
          }
          if (!request.acceptNon2xx) {
            const detail = redactText(
              (await readBody(response, this.maxResponseBytes)).slice(0, 2_000),
            );
            throw httpStatusError(response.status, detail);
          }
        }
        try {
          const body = await readBody(response, this.maxResponseBytes);
          const data =
            request.responseType === 'text'
              ? body
              : body.trim()
                ? (JSON.parse(body) as unknown)
                : null;
          return { status: response.status, headers: response.headers, data: data as T };
        } catch (error: unknown) {
          if (error instanceof IntegrationError && error.code === 'HTTP_RESPONSE_TOO_LARGE') {
            throw error;
          }
          if (attempt < this.maxAttempts) {
            await delay(this.retryDelay(attempt), signal);
            continue;
          }
          throw new IntegrationError(
            'malformed_response',
            'HTTP_RESPONSE_MALFORMED',
            'Integration returned a malformed response after finite retries.',
            true,
            response.status,
            { cause: error },
          );
        }
      } catch (error: unknown) {
        if (error instanceof IntegrationError) {
          if (error.retryable && attempt < this.maxAttempts) {
            await delay(this.retryDelay(attempt), signal);
            continue;
          }
          throw error;
        }
        if (attempt < this.maxAttempts) {
          await delay(this.retryDelay(attempt), signal);
          continue;
        }
        throw new IntegrationError(
          'dependency',
          'HTTP_NETWORK_FAILED',
          'Integration network request failed after finite retries.',
          true,
          undefined,
          { cause: error },
        );
      }
    }
    throw new IntegrationError(
      'dependency',
      'HTTP_RETRY_EXHAUSTED',
      'Integration request exhausted its retry budget.',
      true,
    );
  }

  private createUrl(path: string, query: HttpRequestOptions['query']): URL {
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('..') ||
      path.includes('?') ||
      path.includes('#') ||
      /^[a-z][a-z\d+.-]*:/i.test(path)
    ) {
      throw new IntegrationError(
        'validation',
        'HTTP_PATH_INVALID',
        'Integration path must be a safe relative path.',
        false,
      );
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new IntegrationError(
        'unauthorized',
        'HTTP_ORIGIN_NOT_APPROVED',
        'Integration request attempted to leave its approved origin.',
        false,
      );
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async fetchAttempt(
    url: URL,
    request: HttpRequestOptions,
    externalSignal: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort(externalSignal.reason);
    externalSignal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImplementation(url, {
        method: request.method ?? 'GET',
        headers: {
          accept: request.responseType === 'text' ? 'text/plain, */*' : 'application/json',
          ...this.options.defaultHeaders,
          ...request.headers,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (externalSignal.aborted) {
        throw new IntegrationError(
          'cancelled',
          'INTEGRATION_CANCELLED',
          'Integration request was cancelled.',
          false,
          undefined,
          { cause: error },
        );
      }
      if (timedOut) {
        throw new IntegrationError(
          'timeout',
          'HTTP_TIMEOUT',
          `Integration request exceeded ${this.timeoutMs} ms.`,
          true,
          undefined,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', abort);
    }
  }

  private retryDelay(attempt: number, headers?: Headers): number {
    const retryAfter = headers ? parseRetryAfter(headers.get('retry-after')) : undefined;
    return Math.min(
      retryAfter ?? this.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
      this.maxRetryDelayMs,
    );
  }
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Integration base URL must use HTTP(S) and must not embed credentials.');
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

function httpStatusError(status: number, detail: string): IntegrationError {
  const suffix = detail ? ` Remote detail: ${detail}` : '';
  if (status === 401 || status === 403) {
    return new IntegrationError(
      'unauthorized',
      'HTTP_ACCESS_DENIED',
      `Integration denied the read request (HTTP ${status}).${suffix}`,
      false,
      status,
    );
  }
  if (status === 404) {
    return new IntegrationError(
      'not_found',
      'HTTP_RESOURCE_NOT_FOUND',
      `Integration resource was not found (HTTP 404).${suffix}`,
      false,
      status,
    );
  }
  if (status === 429) {
    return new IntegrationError(
      'rate_limited',
      'HTTP_RATE_LIMITED',
      `Integration rate limit persisted after finite retries.${suffix}`,
      true,
      status,
    );
  }
  return new IntegrationError(
    'remote',
    'HTTP_REMOTE_ERROR',
    `Integration returned HTTP ${status}.${suffix}`,
    isRetryableStatus(status),
    status,
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new IntegrationError(
      'remote',
      'HTTP_RESPONSE_TOO_LARGE',
      `Integration response exceeded ${maxBytes} bytes.`,
      false,
      response.status,
    );
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new IntegrationError(
        'remote',
        'HTTP_RESPONSE_TOO_LARGE',
        `Integration response exceeded ${maxBytes} bytes.`,
        false,
        response.status,
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfIntegrationAborted(signal);
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
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
          'Integration request was cancelled.',
          false,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function readInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}
