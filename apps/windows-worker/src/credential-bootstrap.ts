import {
  resolveEnvironmentCredentialReferences,
  type ProtectedCredential,
} from '@feishu-agent/credentials';

const credentialEnvironmentNames = ['FEISHU_APP_SECRET', 'GITLAB_TOKEN', 'OPENAI_API_KEY'] as const;

export interface CredentialResolverPort {
  resolve(reference: {
    name: string;
    provider: 'windows_credential_manager';
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
  return resolveEnvironmentCredentialReferences({
    names: [...credentialEnvironmentNames],
    environment,
    allowedTargetPrefixes: prefixes,
    ...(resolver ? { resolver } : {}),
  });
}
