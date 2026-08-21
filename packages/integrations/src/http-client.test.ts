import { describe, expect, it, vi } from 'vitest';

import { RetryingHttpClient } from './http-client.js';

describe('RetryingHttpClient', () => {
  it('honors Retry-After with a finite retry budget', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":"slow down"}', {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const client = new RetryingHttpClient({
      baseUrl: 'https://service.example/api/',
      fetchImplementation,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
    });

    const result = await client.request('resource', {}, new AbortController().signal);

    expect(result.data).toEqual({ ok: true });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('retries malformed JSON only up to the configured limit', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{not-json', { status: 200 }));
    const client = new RetryingHttpClient({
      baseUrl: 'https://service.example/api/',
      fetchImplementation,
      maxAttempts: 3,
      retryBaseDelayMs: 0,
    });

    await expect(
      client.request('resource', {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'HTTP_RESPONSE_MALFORMED', retryable: true });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('rejects origin escapes before sending credentials', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new RetryingHttpClient({
      baseUrl: 'https://service.example/api/',
      defaultHeaders: { authorization: 'Bearer secret' },
      fetchImplementation,
    });

    await expect(
      client.request('https://attacker.example/', {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'HTTP_PATH_INVALID' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('retries timeouts and reports exhaustion without leaking request headers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const client = new RetryingHttpClient({
      baseUrl: 'https://service.example/api/',
      defaultHeaders: { authorization: 'Bearer timeout-secret' },
      fetchImplementation,
      maxAttempts: 2,
      timeoutMs: 50,
      retryBaseDelayMs: 0,
    });

    const error = await client
      .request('resource', {}, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'HTTP_TIMEOUT', retryable: true });
    expect(String(error)).not.toContain('timeout-secret');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
