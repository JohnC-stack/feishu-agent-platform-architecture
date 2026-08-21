import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApprovalDecisionActionSchema, RiskLevelSchema } from '@feishu-agent/contracts';

import type { GovernanceService } from './governance-service.js';

const IdentityQuerySchema = z.object({
  userId: z.string().min(1).max(500),
  groupIds: z.string().optional(),
});

const OperationRequestSchema = z.object({
  taskId: z.string().uuid(),
  requestedBy: z.string().min(1).max(500),
  chatId: z.string().min(1).max(500),
  groupIds: z.array(z.string().min(1).max(500)).max(100).default([]),
  toolName: z.string().min(1).max(200),
  riskLevel: RiskLevelSchema,
  resourceType: z.string().min(1).max(100),
  resourceId: z.string().min(1).max(1_000),
  idempotencyKey: z.string().min(16).max(500),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const ApprovalParametersSchema = z.object({ approvalId: z.string().uuid() });
const ApprovalDecisionSchema = z.object({
  actorId: z.string().min(1).max(500),
  groupIds: z.array(z.string().min(1).max(500)).max(100).default([]),
  action: ApprovalDecisionActionSchema,
  reason: z.string().min(1).max(2_000).optional(),
});

const AuditExportQuerySchema = z.object({
  actorId: z.string().min(1).max(500),
  groupIds: z.string().optional(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
});

export function registerGovernanceRoutes(
  app: FastifyInstance,
  governance: GovernanceService,
): void {
  app.get('/v1/governance/capabilities', (request) => {
    const query = IdentityQuerySchema.parse(request.query);
    return governance.capabilities({
      userId: query.userId,
      groupIds: parseGroupIds(query.groupIds),
    });
  });

  app.post('/v1/governance/operations', async (request, reply) => {
    const operation = OperationRequestSchema.parse(request.body);
    const result = await governance.requestOperation(operation);
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.post('/v1/governance/approvals/:approvalId/decisions', async (request) => {
    const { approvalId } = ApprovalParametersSchema.parse(request.params);
    const decision = ApprovalDecisionSchema.parse(request.body);
    return governance.decideApproval({ approvalId, ...decision });
  });

  app.get('/v1/governance/audit/export', async (request) => {
    const query = AuditExportQuerySchema.parse(request.query);
    return {
      events: await governance.exportAudit({
        actorId: query.actorId,
        groupIds: parseGroupIds(query.groupIds),
        from: query.from,
        to: query.to,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    };
  });
}

function parseGroupIds(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
