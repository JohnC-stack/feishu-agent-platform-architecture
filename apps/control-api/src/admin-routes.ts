import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AdminService } from './admin-service.js';
import { FeishuOAuthError, type FeishuOAuthService } from './feishu-oauth-service.js';
import { GovernanceAuthorizationError } from './governance-service.js';

const SnapshotQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const TaskParametersSchema = z.object({ taskId: z.string().uuid() });
const AlertParametersSchema = z.object({ alertId: z.string().uuid() });
const ConfigParametersSchema = z.object({ configId: z.string().uuid() });
const AdminActionSchema = z.object({
  action: z.enum(['cancel', 'retry', 'cleanup', 'restart', 'rollback']),
  targetType: z.string().min(1).max(100),
  targetId: z.string().min(1).max(1_000),
  confirmation: z.string().min(1).max(2_000),
});
const RoleBindingSchema = z.object({
  principalType: z.enum(['user', 'group']),
  principalId: z.string().trim().min(3).max(500),
  roleId: z.enum(['reader', 'operator', 'approver', 'auditor', 'administrator']),
});
const ManagedConfigurationSchema = z.record(z.string().min(1).max(200), z.unknown());
const ConfigValidationSchema = z.object({ configuration: ManagedConfigurationSchema }).strict();
const ConfigDraftSchema = z
  .object({
    configuration: ManagedConfigurationSchema,
    description: z.string().trim().min(1).max(1_000),
    changeSummary: z.string().trim().min(1).max(2_000),
    baseVersion: z.number().int().positive().optional(),
  })
  .strict();
const ConfigDraftUpdateSchema = ConfigDraftSchema.omit({ baseVersion: true });
const ConfigPublishSchema = z.object({ confirmation: z.string().trim().min(1).max(200) }).strict();
const ConfigRollbackSchema = z
  .object({
    confirmation: z.string().trim().min(1).max(200),
    changeSummary: z.string().trim().min(1).max(2_000),
  })
  .strict();
const FeishuCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4_096).optional(),
  state: z.string().min(1).max(512),
  error: z.literal('access_denied').optional(),
});
const adminSessionCookie = 'feishu_agent_admin_session';

export class AdminAuthenticationError extends Error {
  public readonly code = 'ADMIN_SESSION_REQUIRED';

  public constructor() {
    super('A valid administrative session is required.');
    this.name = 'AdminAuthenticationError';
  }
}

export function registerAdminRoutes(
  app: FastifyInstance,
  admin: AdminService,
  feishuOAuth?: FeishuOAuthService,
): void {
  app.get('/v1/admin/auth/config', () => ({
    feishu: feishuOAuth?.getPublicConfig() ?? { enabled: false },
    ...admin.getAccessConfig(),
  }));

  app.get('/v1/admin/auth/feishu/start', (_request, reply) => {
    if (!feishuOAuth?.getPublicConfig().enabled) {
      return reply.code(404).send({ error: 'FEISHU_OAUTH_DISABLED' });
    }
    return reply.redirect(feishuOAuth.beginAuthorization());
  });

  app.get('/v1/admin/auth/feishu/super-admin/start', (_request, reply) => {
    if (!feishuOAuth?.getPublicConfig().enabled) {
      return reply.code(404).send({ error: 'FEISHU_OAUTH_DISABLED' });
    }
    return reply.redirect(feishuOAuth.beginAuthorization('super_admin'));
  });

  app.get('/v1/admin/auth/feishu/callback', async (request, reply) => {
    if (!feishuOAuth?.getPublicConfig().enabled) {
      return reply.code(404).send({ error: 'FEISHU_OAUTH_DISABLED' });
    }
    const query = FeishuCallbackQuerySchema.parse(request.query);
    let loginMode: 'standard' | 'super_admin' = 'standard';
    try {
      if (query.error === 'access_denied') feishuOAuth.rejectAuthorization(query.state);
      if (!query.code) {
        return reply.redirect(feishuOAuth.errorRedirectUrl('FEISHU_OAUTH_CODE_MISSING'));
      }
      const authorization = await feishuOAuth.completeAuthorization({
        code: query.code,
        state: query.state,
      });
      loginMode = authorization.mode;
      const ttlMs = feishuOAuth.getSessionTtlMs();
      const session = admin.createFeishuSession({
        actorId: authorization.user.openId,
        displayName: authorization.user.name,
        ttlMs,
        requireSuperAdmin: loginMode === 'super_admin',
      });
      setAdminSessionCookie(reply, session.accessToken, ttlMs, isSecureRedirect(feishuOAuth));
      return reply.redirect(feishuOAuth.successRedirectUrl(loginMode));
    } catch (error: unknown) {
      if (error instanceof FeishuOAuthError) {
        return reply.redirect(feishuOAuth.errorRedirectUrl(error.code));
      }
      if (error instanceof GovernanceAuthorizationError) {
        const code =
          error.code === 'FEISHU_SUPER_ADMIN_REQUIRED'
            ? 'FEISHU_SUPER_ADMIN_REQUIRED'
            : 'FEISHU_ADMIN_NOT_AUTHORIZED';
        return reply.redirect(
          feishuOAuth.errorRedirectUrl(
            code,
            loginMode === 'super_admin' ? 'super-admin-login' : 'overview',
          ),
        );
      }
      throw error;
    }
  });

  app.get('/v1/admin/session', (request, reply) => {
    const token = readSessionToken(request);
    const session = token ? admin.describeSession(token) : undefined;
    return session
      ? reply.send(session)
      : reply.code(401).send({ error: 'ADMIN_SESSION_REQUIRED' });
  });

  app.post('/v1/admin/session/logout', (request, reply) => {
    const token = readSessionToken(request);
    if (token) admin.revokeSession(token);
    clearAdminSessionCookie(reply);
    return reply.send({ loggedOut: true });
  });

  app.post('/v1/admin/session/local', (request, reply) => {
    const session = admin.createLocalSession(request.ip);
    return session
      ? reply.send(session)
      : reply.code(404).send({ error: 'local_admin_session_unavailable' });
  });

  app.get('/v1/admin/snapshot', async (request) => {
    const query = SnapshotQuerySchema.parse(request.query);
    return admin.snapshot(readIdentity(request, admin), query.limit);
  });

  app.get('/v1/admin/tasks/:taskId/trace', async (request, reply) => {
    const { taskId } = TaskParametersSchema.parse(request.params);
    const trace = await admin.taskTrace(readIdentity(request, admin), taskId);
    return trace ? reply.send(trace) : reply.code(404).send({ error: 'task_not_found' });
  });

  app.post('/v1/admin/actions', async (request, reply) => {
    const input = AdminActionSchema.parse(request.body);
    const operation = await admin.requestAction(readIdentity(request, admin), input);
    return reply.code(operation.status === 'pending_approval' ? 202 : 200).send(operation);
  });

  app.post('/v1/admin/alerts/:alertId/acknowledge', async (request, reply) => {
    const { alertId } = AlertParametersSchema.parse(request.params);
    const result = await admin.acknowledgeAlert(readIdentity(request, admin), alertId);
    return result.acknowledged
      ? reply.send(result)
      : reply.code(409).send({ error: 'alert_not_open' });
  });

  app.post('/v1/admin/access/role-bindings', async (request) => {
    const binding = RoleBindingSchema.parse(request.body);
    return admin.upsertRoleBinding(readIdentity(request, admin), binding);
  });

  app.delete('/v1/admin/access/role-bindings', async (request, reply) => {
    const binding = RoleBindingSchema.parse(request.body);
    const result = await admin.deleteRoleBinding(readIdentity(request, admin), binding);
    if (result.result === 'protected') {
      return reply.code(409).send({ error: 'BOOTSTRAP_ROLE_BINDING_PROTECTED' });
    }
    if (result.result === 'not_found') {
      return reply.code(404).send({ error: 'ROLE_BINDING_NOT_FOUND' });
    }
    return reply.send(result);
  });

  app.post('/v1/admin/config/validate', (request) => {
    const input = ConfigValidationSchema.parse(request.body);
    return admin.validateConfig(readIdentity(request, admin), input.configuration);
  });

  app.post('/v1/admin/config/versions', async (request, reply) => {
    const input = ConfigDraftSchema.parse(request.body);
    const draft = await admin.createConfigDraft(readIdentity(request, admin), input);
    return reply.code(201).send(draft);
  });

  app.patch('/v1/admin/config/versions/:configId', async (request) => {
    const { configId } = ConfigParametersSchema.parse(request.params);
    const input = ConfigDraftUpdateSchema.parse(request.body);
    return admin.updateConfigDraft(readIdentity(request, admin), configId, input);
  });

  app.post('/v1/admin/config/versions/:configId/publish', async (request) => {
    const { configId } = ConfigParametersSchema.parse(request.params);
    const input = ConfigPublishSchema.parse(request.body);
    return admin.publishConfigDraft(readIdentity(request, admin), configId, input.confirmation);
  });

  app.post('/v1/admin/config/versions/:configId/rollback', async (request) => {
    const { configId } = ConfigParametersSchema.parse(request.params);
    const input = ConfigRollbackSchema.parse(request.body);
    return admin.rollbackConfigVersion(readIdentity(request, admin), configId, input);
  });
}

function readIdentity(
  request: FastifyRequest,
  admin: AdminService,
): { actorId: string; groupIds?: string[] } {
  const sessionToken = readSessionToken(request);
  const sessionIdentity = sessionToken ? admin.resolveAdminSession(sessionToken) : undefined;
  if (sessionIdentity) return sessionIdentity;
  const actorId = readHeader(request.headers['x-admin-actor-id']);
  if (!actorId || !admin.canUseManualIdentity(request.ip)) {
    throw new AdminAuthenticationError();
  }
  return {
    actorId,
    groupIds: [
      ...new Set(
        readHeader(request.headers['x-admin-group-ids'])
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
  };
}

function readBearerToken(value: string | string[] | undefined): string {
  const header = readHeader(value);
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function readSessionToken(request: FastifyRequest): string {
  return (
    readBearerToken(request.headers.authorization) ||
    readCookie(request.headers.cookie, adminSessionCookie)
  );
}

function readCookie(value: string | undefined, name: string): string {
  for (const item of (value ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const encoded = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(encoded);
    } catch {
      return '';
    }
  }
  return '';
}

function setAdminSessionCookie(
  reply: FastifyReply,
  token: string,
  ttlMs: number,
  secure: boolean,
): void {
  const attributes = [
    `${adminSessionCookie}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(1, Math.floor(ttlMs / 1_000))}`,
    ...(secure ? ['Secure'] : []),
  ];
  reply.header('set-cookie', attributes.join('; '));
}

function clearAdminSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${adminSessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isSecureRedirect(feishuOAuth: FeishuOAuthService): boolean {
  const redirectUri = feishuOAuth.getPublicConfig().redirectUri;
  return Boolean(redirectUri && new URL(redirectUri).protocol === 'https:');
}

function readHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}
