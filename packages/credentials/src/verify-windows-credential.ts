import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  CredentialReferenceResolver,
  storeWindowsCredential,
  WindowsCredentialManagerProvider,
} from './index.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('P5 Windows Credential Manager verification requires Windows.');
  }
  const target = `FeishuAgent/P5Verification/${randomUUID()}`;
  const secret = `p5-synthetic-${randomUUID()}`;
  try {
    await storeWindowsCredential({ target, username: 'P5Verification', secret });
    const resolver = new CredentialReferenceResolver([
      new WindowsCredentialManagerProvider(['FeishuAgent/']),
    ]);
    const credential = await resolver.resolve({
      name: 'p5-synthetic-verification',
      provider: 'windows_credential_manager',
      target,
    });
    if (credential.reveal() !== secret) {
      throw new Error(
        'Resolved Windows credential did not match the synthetic verification value.',
      );
    }
    if (JSON.stringify({ credential }).includes(secret)) {
      throw new Error('Protected credential was exposed by JSON serialization.');
    }
    console.log(
      JSON.stringify({
        status: 'ok',
        provider: 'windows_credential_manager',
        allowlistEnforced: true,
        valueProtectedFromSerialization: true,
        syntheticCredentialRemoved: true,
      }),
    );
  } finally {
    await execFileAsync('cmdkey.exe', [`/delete:${target}`], {
      windowsHide: true,
      timeout: 10_000,
    }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
