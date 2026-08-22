import { describe, expect, it, vi } from 'vitest';

import {
  createPkceChallenge,
  FeishuOAuthError,
  FeishuOAuthService,
} from './feishu-oauth-service.js';

const config = {
  enabled: true,
  clientId: 'cli_test',
  clientSecret: 'test-secret',
  redirectUri: 'http://127.0.0.1:5173/v1/admin/auth/feishu/callback',
  frontendUrl: 'http://127.0.0.1:5173/',
};

describe('Feishu OAuth service', () => {
  it('creates a single-use authorization request with state and S256 PKCE', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'user-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { open_id: 'ou_admin', union_id: 'on_admin', name: '管理员' },
          }),
          { status: 200 },
        ),
      );
    const service = new FeishuOAuthService(config, fetcher);
    const authorization = new URL(service.beginAuthorization());
    const state = authorization.searchParams.get('state') ?? '';

    expect(authorization.origin + authorization.pathname).toBe(
      'https://open.feishu.cn/open-apis/authen/v1/authorize',
    );
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toHaveLength(43);
    expect(authorization.searchParams.get('scope')).toBeNull();

    await expect(service.completeAuthorization({ code: 'one-time-code', state })).resolves.toEqual({
      mode: 'standard',
      user: {
        openId: 'ou_admin',
        unionId: 'on_admin',
        name: '管理员',
      },
    });
    await expect(service.completeAuthorization({ code: 'replay', state })).rejects.toMatchObject({
      code: 'FEISHU_OAUTH_INVALID_STATE',
    });

    const tokenRequest = fetcher.mock.calls[0] as [string, RequestInit];
    expect(tokenRequest[0]).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    const requestBody = tokenRequest[1].body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON string request body.');
    const tokenBody = JSON.parse(requestBody) as Record<string, string>;
    expect(tokenBody).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'cli_test',
      client_secret: 'test-secret',
      code: 'one-time-code',
      redirect_uri: config.redirectUri,
    });
    expect(tokenBody.code_verifier).toHaveLength(43);
    expect(createPkceChallenge(tokenBody.code_verifier ?? '')).toBe(
      authorization.searchParams.get('code_challenge'),
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://open.feishu.cn/open-apis/authen/v1/user_info');
  });

  it('rejects mismatched state before calling Feishu', async () => {
    const fetcher = vi.fn();
    const service = new FeishuOAuthService(config, fetcher);

    await expect(
      service.completeAuthorization({ code: 'code', state: 'not-issued' }),
    ).rejects.toBeInstanceOf(FeishuOAuthError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds the super administrator intent to the one-time OAuth state', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'user-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { open_id: 'ou_admin', name: '超级管理员' } }),
          { status: 200 },
        ),
      );
    const service = new FeishuOAuthService(config, fetcher);
    const authorization = new URL(service.beginAuthorization('super_admin'));

    await expect(
      service.completeAuthorization({
        code: 'super-code',
        state: authorization.searchParams.get('state') ?? '',
      }),
    ).resolves.toMatchObject({ mode: 'super_admin', user: { openId: 'ou_admin' } });
  });

  it('fails closed when OAuth is disabled', () => {
    const service = new FeishuOAuthService({ enabled: false });

    expect(service.getPublicConfig()).toEqual({ enabled: false });
    expect(() => service.beginAuthorization()).toThrowError(FeishuOAuthError);
  });

  it('derives the RFC 7636 S256 challenge without padding', () => {
    expect(createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
