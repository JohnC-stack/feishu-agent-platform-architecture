import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CredentialReferenceResolver,
  EnterpriseSecretManagerProvider,
  FileSecretProvider,
  ProtectedCredential,
  WindowsCredentialManagerProvider,
  resolveEnvironmentCredentialReferences,
} from './index.js';

describe('P5 credential references', () => {
  it('does not reveal resolved credentials through stringification or JSON', () => {
    const credential = new ProtectedCredential('synthetic-secret');
    expect(String(credential)).toBe('[PROTECTED_CREDENTIAL]');
    expect(JSON.stringify({ credential })).toBe('{"credential":"[PROTECTED_CREDENTIAL]"}');
    expect(credential.reveal()).toBe('synthetic-secret');
  });

  it('enforces the Windows Credential Manager target allowlist', async () => {
    const runner = vi.fn(() => Promise.resolve('synthetic-secret'));
    const provider = new WindowsCredentialManagerProvider(['FeishuAgent/'], runner);
    await expect(provider.resolve('OtherApp/Production')).rejects.toThrow('outside');
    await expect(provider.resolve('FeishuAgent/P5/Test')).resolves.toBeInstanceOf(
      ProtectedCredential,
    );
    expect(runner).toHaveBeenCalledOnce();
  });

  it('resolves only through the provider named by the persisted reference', async () => {
    const resolver = new CredentialReferenceResolver([
      new EnterpriseSecretManagerProvider(() => Promise.resolve('vault-secret')),
    ]);
    const result = await resolver.resolve({
      name: 'gitlab-read-token',
      provider: 'enterprise_secret_manager',
      target: 'secret/data/feishu-agent/gitlab',
    });
    expect(result.reveal()).toBe('vault-secret');
    await expect(
      resolver.resolve({
        name: 'missing-provider',
        provider: 'windows_credential_manager',
        target: 'FeishuAgent/Missing',
      }),
    ).rejects.toThrow('not configured');
  });

  it('loads an allowlisted file secret without retaining its trailing newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-agent-file-secret-'));
    const target = join(root, 'database-url');
    const outside = join(tmpdir(), 'not-allowlisted-secret');
    try {
      await writeFile(target, 'postgres://synthetic\n', { mode: 0o600 });
      await chmod(target, 0o600);
      const provider = new FileSecretProvider([root]);
      await expect(provider.resolve(target)).resolves.toMatchObject({});
      expect((await provider.resolve(target)).reveal()).toBe('postgres://synthetic');
      await expect(provider.resolve(outside)).rejects.toThrow('outside');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves explicit filecred references and leaves plain values unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-agent-env-secret-'));
    const target = join(root, 'credential');
    try {
      await writeFile(target, 'synthetic-file-secret\n', { mode: 0o600 });
      await chmod(target, 0o600);
      const environment = {
        DATABASE_URL: `filecred://${encodeURIComponent(target)}`,
        REDIS_URL: 'redis://127.0.0.1:6379',
      };
      await expect(
        resolveEnvironmentCredentialReferences({
          names: ['DATABASE_URL', 'REDIS_URL'],
          environment,
          allowedFileRoots: [root],
        }),
      ).resolves.toEqual({ resolvedNames: ['DATABASE_URL'] });
      expect(environment).toEqual({
        DATABASE_URL: 'synthetic-file-secret',
        REDIS_URL: 'redis://127.0.0.1:6379',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
