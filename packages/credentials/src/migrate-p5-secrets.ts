import {
  CredentialReferenceResolver,
  storeWindowsCredential,
  WindowsCredentialManagerProvider,
} from './index.js';

const mappings = [
  { environmentName: 'FEISHU_APP_SECRET', target: 'FeishuAgent/Feishu/AppSecret' },
  { environmentName: 'GITLAB_TOKEN', target: 'FeishuAgent/GitLab/ReadApiToken' },
] as const;

async function main(): Promise<void> {
  const resolver = new CredentialReferenceResolver([
    new WindowsCredentialManagerProvider(['FeishuAgent/']),
  ]);
  const migrated: string[] = [];
  const alreadyReferenced: string[] = [];
  for (const mapping of mappings) {
    const value = process.env[mapping.environmentName]?.trim();
    if (!value) throw new Error(`${mapping.environmentName} is not configured.`);
    if (value.startsWith('wincred://')) {
      const target = decodeURIComponent(value.slice('wincred://'.length));
      await resolver.resolve({
        name: mapping.environmentName.toLowerCase(),
        provider: 'windows_credential_manager',
        target,
      });
      alreadyReferenced.push(mapping.environmentName);
      continue;
    }
    await storeWindowsCredential({
      target: mapping.target,
      username: 'FeishuAgent',
      secret: value,
    });
    const stored = await resolver.resolve({
      name: mapping.environmentName.toLowerCase(),
      provider: 'windows_credential_manager',
      target: mapping.target,
    });
    if (stored.reveal() !== value) {
      throw new Error(`${mapping.environmentName} failed post-write verification.`);
    }
    migrated.push(mapping.environmentName);
  }
  console.log(JSON.stringify({ status: 'ok', migrated, alreadyReferenced }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
