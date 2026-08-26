import {
  resolveEnvironmentCredentialReferences,
  type ProtectedCredential,
} from '@feishu-agent/credentials';

const credentialEnvironmentNames = [
  'FEISHU_APP_SECRET',
  'GITLAB_TOKEN',
  'CONFLUENCE_PASSWORD',
  'OPENAI_API_KEY',
] as const;

export interface CredentialResolverPort {
  resolve(reference: {
    name: string;
    provider: 'windows_credential_manager' | 'file_secret' | 'enterprise_secret_manager';
    target: string;
  }): Promise<ProtectedCredential>;
}

export async function resolveCredentialEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  resolver?: CredentialResolverPort,
): Promise<{ resolvedNames: string[] }> {
  const prefixes = [
    ...new Set(
      (environment.CREDENTIAL_TARGET_PREFIXES ?? 'FeishuAgent/')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const allowedFileRoots = [
    ...new Set(
      (environment.CREDENTIAL_FILE_ROOTS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return resolveEnvironmentCredentialReferences({
    names: [...credentialEnvironmentNames],
    environment,
    allowedTargetPrefixes: prefixes,
    allowedFileRoots,
    enforceFilePermissions: readBoolean(
      environment.CREDENTIAL_FILE_ENFORCE_POSIX_PERMISSIONS,
      true,
      'CREDENTIAL_FILE_ENFORCE_POSIX_PERMISSIONS',
    ),
    ...(resolver ? { resolver } : {}),
  });
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.trim().toLowerCase() === 'true') return true;
  if (value.trim().toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}
