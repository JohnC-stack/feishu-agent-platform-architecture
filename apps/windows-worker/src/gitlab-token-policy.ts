export interface GitLabTokenPolicyOptions {
  baseUrl: string;
  token: string;
  signal: AbortSignal;
  fetchImplementation?: typeof fetch;
}

export interface GitLabTokenPolicyResult {
  ok: boolean;
  code?: string;
}

export async function verifyGitLabTokenPolicy(
  options: GitLabTokenPolicyOptions,
): Promise<GitLabTokenPolicyResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const endpoint = new URL(
    '/api/v4/personal_access_tokens/self',
    `${options.baseUrl.replace(/\/$/, '')}/`,
  );
  try {
    const response = await fetchImplementation(endpoint, {
      headers: { accept: 'application/json', 'private-token': options.token },
      redirect: 'error',
      signal: options.signal,
    });
    if (!response.ok) {
      return { ok: false, code: 'GITLAB_TOKEN_POLICY_UNAVAILABLE' };
    }
    const payload = asRecord(await response.json());
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    const minimalScopes = scopes.length === 1 && scopes[0] === 'read_api';
    const active = payload.active === true && payload.revoked !== true;
    return active && minimalScopes
      ? { ok: true }
      : { ok: false, code: 'GITLAB_TOKEN_SCOPE_NOT_MINIMAL' };
  } catch {
    return { ok: false, code: 'GITLAB_TOKEN_POLICY_CHECK_FAILED' };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
