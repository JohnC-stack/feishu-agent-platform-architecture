import { describe, expect, it, vi } from 'vitest';

import { FeishuReadonlyClient } from './feishu.js';

describe('FeishuReadonlyClient contract', () => {
  it('authenticates once and reads approved document metadata and blocks', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
        expect(init?.method).toBe('POST');
        return Promise.resolve(
          jsonResponse({ code: 0, tenant_access_token: 't-private-token-value', expire: 7200 }),
        );
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t-private-token-value');
      if (url.includes('/blocks')) {
        return Promise.resolve(jsonResponse({ code: 0, data: { items: [{ block_id: 'b1' }] } }));
      }
      return Promise.resolve(
        jsonResponse({ code: 0, data: { document: { document_id: 'doc-approved' } } }),
      );
    });
    const client = createClient(fetchImplementation);

    const result = await client.getDocument('doc-approved', new AbortController().signal);

    expect(result.data).toMatchObject({
      metadata: { document: { document_id: 'doc-approved' } },
      blocks: { items: [{ block_id: 'b1' }] },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('t-private-token-value');
  });

  it('blocks unapproved Feishu resources before requesting a tenant token', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createClient(fetchImplementation);

    await expect(client.getChat('chat-secret', new AbortController().signal)).rejects.toMatchObject(
      { code: 'RESOURCE_NOT_APPROVED' },
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('classifies Feishu permission failures as non-retryable', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      return Promise.resolve(
        requestUrl(input).includes('/auth/')
          ? jsonResponse({ code: 0, tenant_access_token: 't-token-for-test', expire: 7200 })
          : jsonResponse({ code: 99991672, msg: 'permission denied' }, 400),
      );
    });
    const client = createClient(fetchImplementation);

    await expect(client.getUser('ou_approved', new AbortController().signal)).rejects.toMatchObject(
      { code: 'FEISHU_ACCESS_DENIED', retryable: false },
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});

function createClient(fetchImplementation: typeof fetch): FeishuReadonlyClient {
  return new FeishuReadonlyClient({
    appId: 'cli_test',
    appSecret: 'app-secret',
    allowedDocumentIds: ['doc-approved'],
    allowedBitableAppTokens: ['bitable-approved'],
    allowedChatIds: ['chat-approved'],
    allowedUserIds: ['ou_approved'],
    baseUrl: 'https://open.feishu.example/open-apis/',
    retryBaseDelayMs: 0,
    http: { fetchImplementation, retryBaseDelayMs: 0 },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
