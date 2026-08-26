import { describe, expect, it, vi } from 'vitest';
import { join, resolve as resolvePath } from 'node:path';

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

  it('resolves file credentials from explicitly allowed service secret roots', async () => {
    const secretRoot = resolvePath('credential-fixtures', 'service-secrets');
    const secretTarget = join(secretRoot, 'gitlab-token');
    const environment = {
      GITLAB_TOKEN: `filecred://${secretTarget}`,
      CREDENTIAL_FILE_ROOTS: secretRoot,
    };
    const resolve = vi.fn(() => Promise.resolve(new ProtectedCredential('resolved-token')));

    const result = await resolveCredentialEnvironment(environment, { resolve });

    expect(environment.GITLAB_TOKEN).toBe('resolved-token');
    expect(result).toEqual({ resolvedNames: ['GITLAB_TOKEN'] });
    expect(resolve).toHaveBeenCalledWith({
      name: 'gitlab_token',
      provider: 'file_secret',
      target: secretTarget,
    });
  });

  it('resolves a Confluence service password without exposing it in bootstrap metadata', async () => {
    const secretRoot = resolvePath('credential-fixtures', 'service-secrets');
    const secretTarget = join(secretRoot, 'confluence-password');
    const environment = {
      CONFLUENCE_PASSWORD: `filecred://${secretTarget}`,
      CREDENTIAL_FILE_ROOTS: secretRoot,
    };
    const resolve = vi.fn(() => Promise.resolve(new ProtectedCredential('resolved-password')));

    const result = await resolveCredentialEnvironment(environment, { resolve });

    expect(environment.CONFLUENCE_PASSWORD).toBe('resolved-password');
    expect(result).toEqual({ resolvedNames: ['CONFLUENCE_PASSWORD'] });
    expect(JSON.stringify(result)).not.toContain('resolved-password');
  });

  it('rejects invalid file permission policy values before worker startup', async () => {
    await expect(
      resolveCredentialEnvironment({ CREDENTIAL_FILE_ENFORCE_POSIX_PERMISSIONS: 'sometimes' }),
    ).rejects.toThrow('must be true or false');
  });
});
