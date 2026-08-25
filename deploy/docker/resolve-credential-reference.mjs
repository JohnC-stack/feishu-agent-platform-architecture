import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { resolveEnvironmentCredentialReferences } from '../../packages/credentials/dist/index.js';

const output = process.env.FEISHU_AGENT_SECRET_OUTPUT;
if (!output || !isAbsolute(output)) {
  throw new Error('FEISHU_AGENT_SECRET_OUTPUT must be an absolute path.');
}

await resolveEnvironmentCredentialReferences({
  names: ['FEISHU_AGENT_SOURCE_REFERENCE'],
  allowedTargetPrefixes: (process.env.CREDENTIAL_TARGET_PREFIXES ?? 'FeishuAgent/')
    .split(/[;,]/u)
    .map((value) => value.trim())
    .filter(Boolean),
  allowedFileRoots: (process.env.CREDENTIAL_FILE_ROOTS ?? '')
    .split(/[;,]/u)
    .map((value) => value.trim())
    .filter(Boolean),
});

const secret = process.env.FEISHU_AGENT_SOURCE_REFERENCE;
if (!secret || secret.startsWith('wincred://') || secret.startsWith('filecred://')) {
  throw new Error('Credential reference did not resolve.');
}
await writeFile(output, secret, { encoding: 'utf8', mode: 0o600, flag: 'w' });
delete process.env.FEISHU_AGENT_SOURCE_REFERENCE;
