import { describe, expect, it, vi } from 'vitest';

import { ConfluenceReadonlyClient, type ConfluenceCommandRunner } from './confluence.js';
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

function createClient(runner: ConfluenceCommandRunner): ConfluenceReadonlyClient {
  return new ConfluenceReadonlyClient({
    runner,
    allowedSpaceKeys: ['ENG'],
    allowedPageIds: ['100'],
    retryBaseDelayMs: 0,
  });
}
