import { describe, expect, it, vi } from 'vitest';

import { GitLabReadonlyClient } from './gitlab.js';

describe('GitLabReadonlyClient contract', () => {
  it('uses a read-only endpoint and token header for an approved project', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      expect(requestUrl(input)).toBe(
        'https://gitlab.example/api/v4/projects/team%2Fapproved/merge_requests/12',
      );
      expect(new Headers(init?.headers).get('private-token')).toBe('read-token');
      expect(init?.method).toBe('GET');
      return Promise.resolve(
        new Response(JSON.stringify({ iid: 12, title: 'Safe MR' }), { status: 200 }),
      );
    });
    const client = createClient(fetchImplementation);

    const result = await client.getMergeRequest('team/approved', 12, new AbortController().signal);

    expect(result).toMatchObject({ data: { iid: 12, title: 'Safe MR' }, truncated: false });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('blocks unapproved projects without a network call', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createClient(fetchImplementation);

    await expect(
      client.getProject('team/secret', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_APPROVED', retryable: false });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('redacts and truncates job traces before returning them to the tool gateway', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(`PRIVATE-TOKEN: glpat-never-return ${'trace'.repeat(200)}`, { status: 200 }),
      );
    const client = createClient(fetchImplementation, 120);

    const result = await client.getJobTrace('team/approved', 44, new AbortController().signal);

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('glpat-never-return');
  });
});

function createClient(fetchImplementation: typeof fetch, maxOutputCharacters = 20_000) {
  return new GitLabReadonlyClient({
    baseUrl: 'https://gitlab.example',
    token: 'read-token',
    allowedProjects: ['team/approved'],
    maxOutputCharacters,
    http: { fetchImplementation, retryBaseDelayMs: 0 },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
