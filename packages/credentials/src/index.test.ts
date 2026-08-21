import { describe, expect, it, vi } from 'vitest';

import {
  CredentialReferenceResolver,
  EnterpriseSecretManagerProvider,
  ProtectedCredential,
  WindowsCredentialManagerProvider,
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
});
