import { describe, expect, it, vi } from 'vitest';

import { verifyGitLabTokenPolicy } from './gitlab-token-policy.js';

describe('GitLab token policy', () => {
  it('accepts an active personal access token with only read_api', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      expect(requestUrl(input)).toBe('https://gitlab.example/api/v4/personal_access_tokens/self');
      expect(new Headers(init?.headers).get('private-token')).toBe('secret-token');
      expect(init?.redirect).toBe('error');
      return Promise.resolve(Response.json({ active: true, revoked: false, scopes: ['read_api'] }));
    });

    const result = await verifyGitLabTokenPolicy({
      baseUrl: 'https://gitlab.example',
      token: 'secret-token',
      signal: new AbortController().signal,
      fetchImplementation,
    });

    expect(result).toEqual({ ok: true });
  });

  it('rejects a token with any additional scope', async () => {
    const result = await verifyGitLabTokenPolicy({
      baseUrl: 'https://gitlab.example',
      token: 'secret-token',
      signal: new AbortController().signal,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          active: true,
          revoked: false,
          scopes: ['read_api', 'manage_runner'],
        }),
      ),
    });

    expect(result).toEqual({ ok: false, code: 'GITLAB_TOKEN_SCOPE_NOT_MINIMAL' });
  });
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
