import { describe, expect, it } from 'vitest';

import { ExactResourceAllowlist } from './access-control.js';
import { boundIntegrationResult } from './redaction.js';

describe('integration result policy', () => {
  it('redacts credential fields and token patterns before truncation', () => {
    const result = boundIntegrationResult(
      {
        authorization: 'Bearer should-never-appear',
        nested: {
          app_secret: 'secret-value',
          trace: `started PRIVATE-TOKEN: glpat-super-secret ${'x'.repeat(300)}`,
        },
      },
      120,
    );

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('should-never-appear');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(JSON.stringify(result)).not.toContain('glpat-super-secret');
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  it('fails closed when a resource is absent from the exact allowlist', () => {
    const allowlist = new ExactResourceAllowlist(['Team/Approved'], 'test project');

    expect(allowlist.assertAllowed('team/approved')).toBe('team/approved');
    expect(() => allowlist.assertAllowed('team/other')).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_NOT_APPROVED', retryable: false }),
    );
  });
});
