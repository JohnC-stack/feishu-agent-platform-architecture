import { describe, expect, it, vi } from 'vitest';

import {
  ConfluenceReadonlyClient,
  LegacyConfluenceSessionRunner,
  type ConfluenceCommandRunner,
} from './confluence.js';
import { IntegrationError } from './errors.js';

describe('ConfluenceReadonlyClient contract', () => {
  it('builds space-constrained CQL and never accepts raw unrestricted CQL', async () => {
    const run = vi.fn<ConfluenceCommandRunner['run']>().mockResolvedValue({ results: [] });
    const client = createClient({ run });

    await client.searchPages('ENG', 'release "risk"', new AbortController().signal, 5);

    expect(run).toHaveBeenCalledWith(
      [
        'search',
        "space='ENG' AND type=page AND text~'release \"risk\"' order by lastmodified desc",
        '--limit',
        '5',
      ],
      expect.any(AbortSignal),
    );
  });

  it('requires both an approved page ID and the expected returned space', async () => {
    const run = vi
      .fn<ConfluenceCommandRunner['run']>()
      .mockResolvedValue({ id: '100', space: { key: 'HR' } });
    const client = createClient({ run });

    await expect(client.getPage('ENG', '100', new AbortController().signal)).rejects.toMatchObject({
      code: 'CONFLUENCE_SPACE_MISMATCH',
    });
    await expect(client.getPage('ENG', '999', new AbortController().signal)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_APPROVED',
    });
  });

  it('uses only GET for attachment metadata after validating the parent page', async () => {
    const run = vi
      .fn<ConfluenceCommandRunner['run']>()
      .mockResolvedValueOnce({ id: '100', space: { key: 'ENG' } })
      .mockResolvedValueOnce({ results: [{ id: 'a1', title: 'guide.pdf' }] });
    const client = createClient({ run });

    const result = await client.listAttachments('ENG', '100', new AbortController().signal);

    expect(run.mock.calls[1]?.[0]).toEqual([
      'api',
      'GET',
      'content/100/child/attachment',
      '-q',
      'limit=25',
    ]);
    expect(result.data).toEqual({ results: [{ id: 'a1', title: 'guide.pdf' }] });
  });

  it('retries transient timeouts only up to the configured budget', async () => {
    const run = vi
      .fn<ConfluenceCommandRunner['run']>()
      .mockRejectedValueOnce(
        new IntegrationError('timeout', 'CONFLUENCE_CLI_TIMEOUT', 'timed out', true),
      )
      .mockResolvedValueOnce({ results: [] });
    const client = createClient({ run });

    await expect(
      client.searchPages('ENG', 'release', new AbortController().signal),
    ).resolves.toMatchObject({ data: { results: [] } });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('LegacyConfluenceSessionRunner', () => {
  it('establishes a legacy session and performs only the mapped read request', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: '/confluence/rest/api/user/current',
            'set-cookie': 'JSESSIONID=session-value; Path=/confluence; HttpOnly',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ username: 'service-user', displayName: 'Service User' }),
      )
      .mockResolvedValueOnce(Response.json({ results: [{ id: '100' }] }));
    const runner = new LegacyConfluenceSessionRunner({
      baseUrl: 'http://confluence.internal/confluence',
      username: 'service-user',
      password: 'local-test-password',
      transport,
    });

    await expect(
      runner.run(
        ['search', "space='ENG' AND type=page", '--limit', '5'],
        new AbortController().signal,
      ),
    ).resolves.toEqual({ results: [{ id: '100' }] });

    expect(transport).toHaveBeenCalledTimes(3);
    const login = transport.mock.calls[0] as unknown as [URL, RequestInit];
    expect(login[0].toString()).toBe('http://confluence.internal/confluence/dologin.action');
    expect(login[1].method).toBe('POST');
    expect(typeof login[1].body).toBe('string');
    expect(login[1].body).toContain('os_destination=%2Frest%2Fapi%2Fuser%2Fcurrent');
    const read = transport.mock.calls[2] as unknown as [URL, RequestInit];
    expect(read[0].toString()).toContain('/confluence/rest/api/content/search?');
    expect(new Headers(read[1].headers).get('cookie')).toBe('JSESSIONID=session-value');
  });

  it('rejects arbitrary REST paths and write operations before network access', async () => {
    const transport = vi.fn();
    const runner = new LegacyConfluenceSessionRunner({
      baseUrl: 'http://confluence.internal/confluence',
      username: 'service-user',
      password: 'local-test-password',
      transport,
    });

    await expect(
      runner.run(['api', 'POST', 'content', '-q', 'limit=1'], new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CONFLUENCE_COMMAND_REJECTED' });
    await expect(
      runner.run(['api', 'GET', 'user/current', '-q', 'limit=1'], new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CONFLUENCE_COMMAND_REJECTED' });
    expect(transport).not.toHaveBeenCalled();
  });
});

function createClient(runner: ConfluenceCommandRunner): ConfluenceReadonlyClient {
  return new ConfluenceReadonlyClient({
    runner,
    allowedSpaceKeys: ['ENG'],
    allowedPageIds: ['100'],
    retryBaseDelayMs: 0,
  });
}
