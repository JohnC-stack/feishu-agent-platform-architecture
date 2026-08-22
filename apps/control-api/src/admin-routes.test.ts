import { describe, expect, it, vi } from 'vitest';

import { createControlApi } from './app.js';
import type { AdminService } from './admin-service.js';
import type { FeishuOAuthService } from './feishu-oauth-service.js';

describe('P6 admin routes', () => {
  it('requires an explicit governed administrator identity', async () => {
    const snapshot = vi.fn();
    const admin = { snapshot, canUseManualIdentity: vi.fn(() => true) } as unknown as AdminService;
    const app = createControlApi({ admin });

    const response = await app.inject({ method: 'GET', url: '/v1/admin/snapshot' });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'ADMIN_SESSION_REQUIRED' });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('returns the P6 snapshot for an authorized identity header', async () => {
    const snapshot = vi.fn(() =>
      Promise.resolve({ phase: 'P6', generatedAt: '2026-08-21T00:00:00.000Z' }),
    );
    const admin = { snapshot, canUseManualIdentity: vi.fn(() => true) } as unknown as AdminService;
    const app = createControlApi({ admin });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/snapshot?limit=25',
      headers: { 'x-admin-actor-id': 'admin-user', 'x-admin-group-ids': 'group-a,group-a' },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ phase: 'P6' });
    expect(snapshot).toHaveBeenCalledWith({ actorId: 'admin-user', groupIds: ['group-a'] }, 25);
  });

  it('creates a loopback local session without exposing the bound actor id', async () => {
    const createLocalSession = vi.fn(() => ({
      accessToken: 'opaque-local-token',
      expiresAt: '2026-08-22T00:00:00.000Z',
      displayName: '本机管理员',
      roleIds: ['administrator'],
    }));
    const admin = { createLocalSession } as unknown as AdminService;
    const app = createControlApi({ admin });

    const response = await app.inject({ method: 'POST', url: '/v1/admin/session/local' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('actorId');
    expect(response.json()).toMatchObject({ accessToken: 'opaque-local-token' });
  });

  it('resolves an opaque bearer session before calling an administrative route', async () => {
    const resolveAdminSession = vi.fn(() => ({ actorId: 'local-admin' }));
    const snapshot = vi.fn(() => Promise.resolve({ phase: 'P6' }));
    const admin = { resolveAdminSession, snapshot } as unknown as AdminService;
    const app = createControlApi({ admin });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/snapshot',
      headers: { authorization: 'Bearer opaque-local-token' },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(resolveAdminSession).toHaveBeenCalledWith('opaque-local-token');
    expect(snapshot).toHaveBeenCalledWith({ actorId: 'local-admin' }, undefined);
  });

  it('completes Feishu OAuth into an HttpOnly admin session without exposing the Open ID', async () => {
    const createFeishuSession = vi.fn(() => ({
      accessToken: 'opaque-feishu-session',
      expiresAt: '2026-08-22T00:00:00.000Z',
      displayName: '飞书管理员',
      roleIds: ['administrator'],
      provider: 'feishu' as const,
    }));
    const admin = { createFeishuSession } as unknown as AdminService;
    const feishuOAuth = {
      getPublicConfig: vi.fn(() => ({
        enabled: true,
        redirectUri: 'http://127.0.0.1:5173/v1/admin/auth/feishu/callback',
      })),
      completeAuthorization: vi.fn(() =>
        Promise.resolve({
          mode: 'standard' as const,
          user: { openId: 'ou_admin', name: '飞书管理员' },
        }),
      ),
      getSessionTtlMs: vi.fn(() => 3_600_000),
      successRedirectUrl: vi.fn(() => 'http://127.0.0.1:5173/?auth=feishu#overview'),
      errorRedirectUrl: vi.fn((code: string) => `http://127.0.0.1:5173/?auth_error=${code}`),
    } as unknown as FeishuOAuthService;
    const app = createControlApi({ admin, feishuOAuth });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/auth/feishu/callback?code=one-time&state=random-state',
    });
    await app.close();

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('http://127.0.0.1:5173/?auth=feishu#overview');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']).not.toContain('ou_admin');
    expect(createFeishuSession).toHaveBeenCalledWith({
      actorId: 'ou_admin',
      displayName: '飞书管理员',
      ttlMs: 3_600_000,
      requireSuperAdmin: false,
    });
  });

  it('starts the dedicated Feishu super-admin authorization flow', async () => {
    const beginAuthorization = vi.fn(() => 'https://open.feishu.cn/open-apis/authen/v1/authorize');
    const feishuOAuth = {
      getPublicConfig: vi.fn(() => ({ enabled: true })),
      beginAuthorization,
    } as unknown as FeishuOAuthService;
    const admin = {} as AdminService;
    const app = createControlApi({ admin, feishuOAuth });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/auth/feishu/super-admin/start',
    });
    await app.close();

    expect(response.statusCode).toBe(302);
    expect(beginAuthorization).toHaveBeenCalledWith('super_admin');
  });

  it('requires the administrator role when a Feishu super-admin callback completes', async () => {
    const createFeishuSession = vi.fn(() => ({
      accessToken: 'opaque-super-admin-session',
      expiresAt: '2026-08-22T00:00:00.000Z',
      displayName: '飞书超级管理员',
      roleIds: ['administrator'],
      provider: 'feishu' as const,
    }));
    const admin = { createFeishuSession } as unknown as AdminService;
    const feishuOAuth = {
      getPublicConfig: vi.fn(() => ({ enabled: true })),
      completeAuthorization: vi.fn(() =>
        Promise.resolve({
          mode: 'super_admin' as const,
          user: { openId: 'ou_super_admin', name: '飞书超级管理员' },
        }),
      ),
      getSessionTtlMs: vi.fn(() => 3_600_000),
      successRedirectUrl: vi.fn(() => 'http://127.0.0.1:5173/?auth=feishu-super-admin#overview'),
      errorRedirectUrl: vi.fn((code: string) => `http://127.0.0.1:5173/?auth_error=${code}`),
    } as unknown as FeishuOAuthService;
    const app = createControlApi({ admin, feishuOAuth });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/auth/feishu/callback?code=one-time&state=super-admin-state',
    });
    await app.close();

    expect(response.statusCode).toBe(302);
    expect(createFeishuSession).toHaveBeenCalledWith({
      actorId: 'ou_super_admin',
      displayName: '飞书超级管理员',
      ttlMs: 3_600_000,
      requireSuperAdmin: true,
    });
  });

  it('adds and removes governed role bindings through the access-management API', async () => {
    const resolveAdminSession = vi.fn(() => ({ actorId: 'ou_super_admin' }));
    const upsertRoleBinding = vi.fn((_identity, binding) =>
      Promise.resolve({ ...binding, managedBy: 'admin-console' }),
    );
    const deleteRoleBinding = vi.fn(() => Promise.resolve({ result: 'deleted' as const }));
    const admin = {
      resolveAdminSession,
      upsertRoleBinding,
      deleteRoleBinding,
    } as unknown as AdminService;
    const app = createControlApi({ admin });
    const binding = {
      principalType: 'user',
      principalId: 'ou_reader',
      roleId: 'reader',
    };

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/access/role-bindings',
      headers: { authorization: 'Bearer opaque-super-admin-session' },
      payload: binding,
    });
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/access/role-bindings',
      headers: { authorization: 'Bearer opaque-super-admin-session' },
      payload: binding,
    });
    await app.close();

    expect(createResponse.statusCode).toBe(200);
    expect(deleteResponse.statusCode).toBe(200);
    expect(upsertRoleBinding).toHaveBeenCalledWith({ actorId: 'ou_super_admin' }, binding);
    expect(deleteRoleBinding).toHaveBeenCalledWith({ actorId: 'ou_super_admin' }, binding);
  });

  it('resolves the HttpOnly session cookie and supports logout', async () => {
    const describeSession = vi.fn(() => ({
      expiresAt: '2026-08-22T00:00:00.000Z',
      displayName: '飞书管理员',
      roleIds: ['administrator'],
      provider: 'feishu' as const,
    }));
    const revokeSession = vi.fn(() => true);
    const admin = { describeSession, revokeSession } as unknown as AdminService;
    const app = createControlApi({ admin });
    const cookie = 'feishu_agent_admin_session=opaque-feishu-session';

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/v1/admin/session',
      headers: { cookie },
    });
    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/session/logout',
      headers: { cookie },
    });
    await app.close();

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).not.toHaveProperty('actorId');
    expect(logoutResponse.json()).toEqual({ loggedOut: true });
    expect(logoutResponse.headers['set-cookie']).toContain('Max-Age=0');
    expect(revokeSession).toHaveBeenCalledWith('opaque-feishu-session');
  });
});
