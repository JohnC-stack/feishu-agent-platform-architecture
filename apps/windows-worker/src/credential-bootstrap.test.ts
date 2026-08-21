import { describe, expect, it, vi } from 'vitest';

import { ProtectedCredential } from '@feishu-agent/credentials';

import { resolveCredentialEnvironment } from './credential-bootstrap.js';

describe('P5 Windows Worker credential bootstrap', () => {
  it('resolves only explicit wincred references and never returns secret values', async () => {
    const environment = {
      FEISHU_APP_SECRET: 'wincred://FeishuAgent/Feishu/AppSecret',
      GITLAB_TOKEN: 'plain-development-value',
    };
    const resolve = vi.fn(() => Promise.resolve(new ProtectedCredential('resolved-secret')));
    const result = await resolveCredentialEnvironment(environment, { resolve });
    expect(environment.FEISHU_APP_SECRET).toBe('resolved-secret');
    expect(environment.GITLAB_TOKEN).toBe('plain-development-value');
    expect(result).toEqual({ resolvedNames: ['FEISHU_APP_SECRET'] });
    expect(JSON.stringify(result)).not.toContain('resolved-secret');
    expect(resolve).toHaveBeenCalledWith({
      name: 'feishu_app_secret',
      provider: 'windows_credential_manager',
      target: 'FeishuAgent/Feishu/AppSecret',
    });
  });

  it('rejects empty credential references before worker startup', async () => {
    await expect(
      resolveCredentialEnvironment(
        { GITLAB_TOKEN: 'wincred://' },
        { resolve: () => Promise.resolve(new ProtectedCredential('unused')) },
      ),
    ).rejects.toThrow('empty');
  });
});
