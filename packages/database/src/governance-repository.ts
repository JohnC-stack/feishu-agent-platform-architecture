import { randomUUID } from 'node:crypto';

import {
  BudgetLimitSchema,
  CredentialReferenceSchema,
  GovernedOperationRequestSchema,
  GovernanceRoleBindingSchema,
  GovernanceRoleSchema,
  type ApprovalDecisionAction,
  type ApprovalStatus,
  type BudgetLimit,
  type BudgetScopeType,
  type CredentialReference,
  type GovernedOperationRequest,
  type GovernedOperationStatus,
  type GovernanceRole,
  type GovernanceRoleBinding,
} from '@feishu-agent/contracts';
import {
  assertApprovalActor,
  evaluateBudget,
  nextApprovalStatus,
  redactAuditDetails,
  requiresApproval,
} from '@feishu-agent/policy';
import type postgres from 'postgres';

import type { DatabaseClient } from './index.js';

type GovernanceSql = DatabaseClient | postgres.TransactionSql;

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  system: boolean;
  permissions: GovernanceRole['permissions'];
}

interface BindingRow {
  principal_type: GovernanceRoleBinding['principalType'];
  principal_id: string;
  role_id: string;
}

interface OperationRow {
  id: string;
  task_id: string;
  requested_by: string;
  chat_id: string;
  tool_name: string;
  operation: GovernedOperationRequest['operation'];
  risk: GovernedOperationRequest['riskLevel'];
  resource_type: string;
  resource_id: string;
  idempotency_key: string;
  request_hash: string;
  status: GovernedOperationStatus;
  approval_request_id: string | null;
  execution_claim_token: string | null;
  expires_at: Date;
  executed_at: Date | null;
  finished_at: Date | null;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  operation_id: string;
  requested_by: string;
  decided_by: string | null;
  status: ApprovalStatus;
  decision_reason: string | null;
  expires_at: Date;
  decided_at: Date | null;
  version: number;
}

interface BudgetLimitRow {
  scope_type: BudgetScopeType;
  scope_id: string;
  period: BudgetLimit['period'];
  token_limit: string | number;
  cost_limit_micros: string | number;
}

interface BudgetUsageRow {
  tokens_used: string | number;
  cost_micros_used: string | number;
}

interface AuditRow {
  id: string | number;
  correlation_id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  details: Record<string, unknown>;
  created_at: Date;
  expires_at: Date;
}

export interface GovernedOperationRecord {
  id: string;
  taskId: string;
  requestedBy: string;
  chatId: string;
  toolName: string;
  operation: GovernedOperationRequest['operation'];
  riskLevel: GovernedOperationRequest['riskLevel'];
  resourceType: string;
  resourceId: string;
  idempotencyKey: string;
  requestHash: string;
  status: GovernedOperationStatus;
  approvalRequestId?: string;
  executionClaimToken?: string;
  expiresAt: string;
  executedAt?: string;
  finishedAt?: string;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  operationId: string;
  requestedBy: string;
  decidedBy?: string;
  status: ApprovalStatus;
  decisionReason?: string;
  expiresAt: string;
  decidedAt?: string;
  version: number;
}

export class GovernanceConflictError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceConflictError';
  }
}

export class BudgetExceededError extends Error {
  public constructor(public readonly violations: ReturnType<typeof evaluateBudget>['violations']) {
    super('One or more governance budgets would be exceeded.');
    this.name = 'BudgetExceededError';
  }
}

export class GovernanceRepository {
  public constructor(private readonly sql: DatabaseClient) {}

  public async seedPolicy(
    rolesInput: GovernanceRole[],
    bindingsInput: GovernanceRoleBinding[],
    managedBy = 'bootstrap',
  ): Promise<void> {
    const roles = rolesInput.map((role) => GovernanceRoleSchema.parse(role));
    const bindings = bindingsInput.map((binding) => GovernanceRoleBindingSchema.parse(binding));
    await this.sql.begin(async (transaction) => {
      for (const role of roles) {
        await transaction`
          INSERT INTO governance_roles (id, name, description, system, permissions)
          VALUES (
            ${role.id},
            ${role.name},
            ${role.description ?? null},
            ${role.system},
            ${transaction.json(toJsonValue(role.permissions))}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            system = EXCLUDED.system,
            permissions = EXCLUDED.permissions,
            updated_at = now()
        `;
      }
      await transaction`
        DELETE FROM governance_role_bindings
        WHERE managed_by = ${managedBy}
      `;
      for (const binding of bindings) {
        await transaction`
          INSERT INTO governance_role_bindings (
            principal_type,
            principal_id,
            role_id,
            managed_by
          ) VALUES (
            ${binding.principalType},
            ${binding.principalId},
            ${binding.roleId},
            ${managedBy}
          )
          ON CONFLICT (principal_type, principal_id, role_id) DO UPDATE SET
            managed_by = EXCLUDED.managed_by
        `;
      }
    });
  }

  public async getPolicySnapshot(): Promise<{
    roles: GovernanceRole[];
    bindings: GovernanceRoleBinding[];
  }> {
    const [roleRows, bindingRows] = await Promise.all([
      this.sql<RoleRow[]>`
        SELECT id, name, description, system, permissions
        FROM governance_roles
        ORDER BY id
      `,
      this.sql<BindingRow[]>`
        SELECT principal_type, principal_id, role_id
        FROM governance_role_bindings
        ORDER BY principal_type, principal_id, role_id
      `,
    ]);
    return {
      roles: roleRows.map((row) =>
        GovernanceRoleSchema.parse({
          id: row.id,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          system: row.system,
          permissions: row.permissions,
        }),
      ),
      bindings: bindingRows.map((row) =>
        GovernanceRoleBindingSchema.parse({
          principalType: row.principal_type,
          principalId: row.principal_id,
          roleId: row.role_id,
        }),
      ),
    };
  }

  public async upsertRoleBinding(
    bindingInput: GovernanceRoleBinding,
    managedBy: string,
  ): Promise<void> {
    const binding = GovernanceRoleBindingSchema.parse(bindingInput);
    await this.sql`
      INSERT INTO governance_role_bindings (
        principal_type,
        principal_id,
        role_id,
        managed_by
      ) VALUES (
        ${binding.principalType},
        ${binding.principalId},
        ${binding.roleId},
        ${managedBy}
      )
      ON CONFLICT (principal_type, principal_id, role_id) DO UPDATE SET
        managed_by = CASE
          WHEN governance_role_bindings.managed_by = 'bootstrap' THEN governance_role_bindings.managed_by
          ELSE EXCLUDED.managed_by
        END
    `;
  }

  public async deleteRoleBinding(
    bindingInput: GovernanceRoleBinding,
  ): Promise<'deleted' | 'protected' | 'not_found'> {
    const binding = GovernanceRoleBindingSchema.parse(bindingInput);
    const deleted = await this.sql<Array<{ managed_by: string }>>`
      DELETE FROM governance_role_bindings
      WHERE principal_type = ${binding.principalType}
        AND principal_id = ${binding.principalId}
        AND role_id = ${binding.roleId}
        AND managed_by <> 'bootstrap'
      RETURNING managed_by
    `;
    if (deleted.length > 0) return 'deleted';
    const existing = await this.sql<Array<{ managed_by: string }>>`
      SELECT managed_by
      FROM governance_role_bindings
      WHERE principal_type = ${binding.principalType}
        AND principal_id = ${binding.principalId}
        AND role_id = ${binding.roleId}
      LIMIT 1
    `;
    return existing[0]?.managed_by === 'bootstrap' ? 'protected' : 'not_found';
  }

  public async createGovernedOperation(
    input: GovernedOperationRequest,
  ): Promise<{ operation: GovernedOperationRecord; approval?: ApprovalRecord; created: boolean }> {
    const request = GovernedOperationRequestSchema.parse(input);
    assertNoInlineSecrets(request.payload);
    return this.sql.begin(async (transaction) => {
      const approvalRequired = requiresApproval(request);
      const status: GovernedOperationStatus = approvalRequired ? 'pending_approval' : 'approved';
      const inserted = await transaction<OperationRow[]>`
        INSERT INTO governed_operations (
          id,
          task_id,
          requested_by,
          chat_id,
          tool_name,
          operation,
          risk,
          resource_type,
          resource_id,
          idempotency_key,
          request_hash,
          payload,
          status,
          expires_at
        ) VALUES (
          ${request.id},
          ${request.taskId},
          ${request.requestedBy},
          ${request.chatId},
          ${request.toolName},
          ${request.operation},
          ${request.riskLevel},
          ${request.resourceType},
          ${request.resourceId},
          ${request.idempotencyKey},
          ${request.requestHash},
          ${transaction.json(toJsonValue(request.payload))},
          ${status},
          ${request.expiresAt}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING ${operationColumns(transaction)}
      `;
      let operationRow = inserted[0];
      if (!operationRow) {
        const existing = await transaction<OperationRow[]>`
          SELECT ${operationColumns(transaction)}
          FROM governed_operations
          WHERE idempotency_key = ${request.idempotencyKey}
        `;
        operationRow = existing[0];
        if (!operationRow) {
          throw new Error('Idempotent governed operation lookup failed.');
        }
        if (operationRow.request_hash !== request.requestHash) {
          throw new GovernanceConflictError(
            'IDEMPOTENCY_KEY_REUSED',
            'The idempotency key is already bound to a different operation request.',
          );
        }
        const approval = operationRow.approval_request_id
          ? await selectApproval(transaction, operationRow.approval_request_id)
          : undefined;
        return {
          operation: mapOperation(operationRow),
          ...(approval ? { approval } : {}),
          created: false,
        };
      }

      let approval: ApprovalRecord | undefined;
      if (approvalRequired) {
        const approvalId = randomUUID();
        const approvalRows = await transaction<ApprovalRow[]>`
          INSERT INTO approval_requests (
            id,
            task_id,
            requested_by,
            status,
            operation,
            expires_at,
            operation_id,
            request_hash
          ) VALUES (
            ${approvalId},
            ${request.taskId},
            ${request.requestedBy},
            'pending',
            ${transaction.json(
              toJsonValue({
                toolName: request.toolName,
                operation: request.operation,
                riskLevel: request.riskLevel,
                resourceType: request.resourceType,
                resourceId: request.resourceId,
              }),
            )},
            ${request.expiresAt},
            ${request.id},
            ${request.requestHash}
          )
          RETURNING ${approvalColumns(transaction)}
        `;
        const approvalRow = approvalRows[0];
        if (!approvalRow) {
          throw new Error(`Approval request creation failed: ${request.id}`);
        }
        const updated = await transaction<OperationRow[]>`
          UPDATE governed_operations
          SET approval_request_id = ${approvalId}, updated_at = now()
          WHERE id = ${request.id}
          RETURNING ${operationColumns(transaction)}
        `;
        operationRow = updated[0] ?? operationRow;
        approval = mapApproval(approvalRow);
      }
      await insertAudit(transaction, {
        correlationId: request.taskId,
        actorType: 'feishu_user',
        actorId: request.requestedBy,
        action: 'governed_operation.requested',
        resourceType: request.resourceType,
        resourceId: request.resourceId,
        outcome: status,
        details: {
          operationId: request.id,
          toolName: request.toolName,
          riskLevel: request.riskLevel,
          approvalRequired,
        },
      });
      return {
        operation: mapOperation(operationRow),
        ...(approval ? { approval } : {}),
        created: true,
      };
    });
  }

  public async decideApproval(input: {
    approvalId: string;
    actorId: string;
    action: ApprovalDecisionAction;
    reason?: string;
    allowSelfApproval?: boolean;
    occurredAt?: string;
  }): Promise<{ approval: ApprovalRecord; operation: GovernedOperationRecord }> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<ApprovalRow[]>`
        SELECT ${approvalColumns(transaction)}
        FROM approval_requests
        WHERE id = ${input.approvalId}
        FOR UPDATE
      `;
      const current = rows[0];
      if (!current) {
        throw new GovernanceConflictError('APPROVAL_NOT_FOUND', 'Approval request was not found.');
      }
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      let action = input.action;
      if (current.status === 'pending' && current.expires_at.getTime() <= Date.parse(occurredAt)) {
        action = 'expire';
      }
      if (action === 'approve' || action === 'reject') {
        try {
          assertApprovalActor({
            requestedBy: current.requested_by,
            decidedBy: input.actorId,
            allowSelfApproval: input.allowSelfApproval,
          });
        } catch (error: unknown) {
          throw new GovernanceConflictError(
            'SELF_APPROVAL_FORBIDDEN',
            error instanceof Error ? error.message : 'Self approval is forbidden.',
          );
        }
      }
      let next: ApprovalStatus;
      try {
        next = nextApprovalStatus(current.status, action);
      } catch (error: unknown) {
        throw new GovernanceConflictError(
          'APPROVAL_STATE_CONFLICT',
          error instanceof Error ? error.message : 'Approval state transition was rejected.',
        );
      }
      const updatedRows = await transaction<ApprovalRow[]>`
        UPDATE approval_requests
        SET
          status = ${next},
          decided_by = ${input.actorId},
          decision_reason = ${input.reason ?? null},
          decided_at = ${occurredAt},
          version = version + 1
        WHERE id = ${input.approvalId}
        RETURNING ${approvalColumns(transaction)}
      `;
      const operationStatus = approvalToOperationStatus(next);
      const operationRows = await transaction<OperationRow[]>`
        UPDATE governed_operations
        SET status = ${operationStatus}, updated_at = ${occurredAt}
        WHERE id = ${current.operation_id}
          AND status IN ('pending_approval', 'approved')
        RETURNING ${operationColumns(transaction)}
      `;
      const updated = updatedRows[0];
      const operation = operationRows[0];
      if (!updated || !operation) {
        throw new GovernanceConflictError(
          'APPROVAL_OPERATION_CONFLICT',
          'The governed operation can no longer accept this approval decision.',
        );
      }
      await insertAudit(transaction, {
        correlationId: operation.task_id,
        actorType: 'feishu_user',
        actorId: input.actorId,
        action: `approval.${action}`,
        resourceType: 'approval',
        resourceId: input.approvalId,
        outcome: next,
        details: { operationId: operation.id, reason: input.reason },
      });
      return { approval: mapApproval(updated), operation: mapOperation(operation) };
    });
  }

  public async claimOperationExecution(
    operationId: string,
  ): Promise<{ claimed: boolean; operation: GovernedOperationRecord }> {
    return this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE governed_operations
        SET status = 'expired', updated_at = now()
        WHERE id = ${operationId}
          AND status IN ('pending_approval', 'approved')
          AND expires_at <= now()
      `;
      const claimToken = randomUUID();
      const claimed = await transaction<OperationRow[]>`
        UPDATE governed_operations
        SET
          status = 'executing',
          execution_claim_token = ${claimToken},
          executed_at = now(),
          updated_at = now()
        WHERE id = ${operationId}
          AND status = 'approved'
          AND expires_at > now()
        RETURNING ${operationColumns(transaction)}
      `;
      const operation = claimed[0] ?? (await selectOperation(transaction, operationId));
      if (!operation) {
        throw new GovernanceConflictError(
          'OPERATION_NOT_FOUND',
          'Governed operation was not found.',
        );
      }
      return { claimed: claimed.length === 1, operation: mapOperation(operation) };
    });
  }

  public async completeOperation(input: {
    operationId: string;
    claimToken: string;
    outcome: 'succeeded' | 'failed';
    resultReference?: string;
    errorCode?: string;
  }): Promise<GovernedOperationRecord> {
    const rows = await this.sql<OperationRow[]>`
      UPDATE governed_operations
      SET
        status = ${input.outcome},
        result_reference = ${input.resultReference ?? null},
        error_code = ${input.errorCode ?? null},
        finished_at = now(),
        updated_at = now()
      WHERE id = ${input.operationId}
        AND status = 'executing'
        AND execution_claim_token = ${input.claimToken}
      RETURNING ${operationColumns(this.sql)}
    `;
    const operation = rows[0];
    if (!operation) {
      throw new GovernanceConflictError(
        'EXECUTION_CLAIM_INVALID',
        'The operation execution claim is missing, stale, or already completed.',
      );
    }
    return mapOperation(operation);
  }

  public async upsertBudgetLimit(input: BudgetLimit): Promise<void> {
    const limit = BudgetLimitSchema.parse(input);
    await this.sql`
      INSERT INTO budget_limits (
        scope_type,
        scope_id,
        period,
        token_limit,
        cost_limit_micros
      ) VALUES (
        ${limit.scopeType},
        ${limit.scopeId},
        ${limit.period},
        ${limit.tokenLimit},
        ${limit.costLimitMicros}
      )
      ON CONFLICT (scope_type, scope_id, period) DO UPDATE SET
        token_limit = EXCLUDED.token_limit,
        cost_limit_micros = EXCLUDED.cost_limit_micros,
        enabled = true,
        updated_at = now()
    `;
  }

  public async reserveBudget(input: {
    taskId: string;
    correlationId: string;
    actorId: string;
    scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }>;
    tokens: number;
    costMicros: number;
    occurredAt?: string;
  }): Promise<{ limitsApplied: number }> {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const reservation: {
      limitsApplied: number;
      violations: ReturnType<typeof evaluateBudget>['violations'];
    } = await this.sql.begin(async (transaction) => {
      const scopes = uniqueScopes(input.scopes);
      for (const scope of scopes) {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${scope.scopeType}:${scope.scopeId}`}, 0)
          )
        `;
      }
      const limits: BudgetLimit[] = [];
      const usage: Array<{
        scopeType: BudgetScopeType;
        scopeId: string;
        period: BudgetLimit['period'];
        tokensUsed: number;
        costMicrosUsed: number;
      }> = [];
      for (const scope of scopes) {
        const rows = await transaction<BudgetLimitRow[]>`
          SELECT scope_type, scope_id, period, token_limit, cost_limit_micros
          FROM budget_limits
          WHERE scope_type = ${scope.scopeType}
            AND scope_id = ${scope.scopeId}
            AND enabled = true
          ORDER BY period
        `;
        for (const row of rows) {
          const limit = BudgetLimitSchema.parse({
            scopeType: row.scope_type,
            scopeId: row.scope_id,
            period: row.period,
            tokenLimit: safeInteger(row.token_limit, 'token_limit'),
            costLimitMicros: safeInteger(row.cost_limit_micros, 'cost_limit_micros'),
          });
          const windowKey = budgetWindowKey(limit.period, input.taskId, occurredAt);
          const usageRows = await transaction<BudgetUsageRow[]>`
            SELECT tokens_used, cost_micros_used
            FROM budget_usage
            WHERE scope_type = ${limit.scopeType}
              AND scope_id = ${limit.scopeId}
              AND period = ${limit.period}
              AND window_key = ${windowKey}
          `;
          limits.push(limit);
          usage.push({
            scopeType: limit.scopeType,
            scopeId: limit.scopeId,
            period: limit.period,
            tokensUsed: safeInteger(usageRows[0]?.tokens_used ?? 0, 'tokens_used'),
            costMicrosUsed: safeInteger(usageRows[0]?.cost_micros_used ?? 0, 'cost_micros_used'),
          });
        }
      }
      const result = evaluateBudget({
        limits,
        usage,
        proposedTokens: input.tokens,
        proposedCostMicros: input.costMicros,
      });
      if (!result.allowed) {
        return { limitsApplied: limits.length, violations: result.violations };
      }
      for (const limit of limits) {
        const windowKey = budgetWindowKey(limit.period, input.taskId, occurredAt);
        await transaction`
          INSERT INTO budget_usage (
            scope_type,
            scope_id,
            period,
            window_key,
            tokens_used,
            cost_micros_used
          ) VALUES (
            ${limit.scopeType},
            ${limit.scopeId},
            ${limit.period},
            ${windowKey},
            ${input.tokens},
            ${input.costMicros}
          )
          ON CONFLICT (scope_type, scope_id, period, window_key) DO UPDATE SET
            tokens_used = budget_usage.tokens_used + EXCLUDED.tokens_used,
            cost_micros_used = budget_usage.cost_micros_used + EXCLUDED.cost_micros_used,
            updated_at = now()
        `;
      }
      await insertAudit(transaction, {
        correlationId: input.correlationId,
        actorType: 'feishu_user',
        actorId: input.actorId,
        action: 'budget.reserve',
        resourceType: 'task',
        resourceId: input.taskId,
        outcome: 'accepted',
        details: {
          tokens: input.tokens,
          costMicros: input.costMicros,
          limitsApplied: limits.length,
        },
      });
      return { limitsApplied: limits.length, violations: [] };
    });
    if (reservation.violations.length > 0) {
      await insertAudit(this.sql, {
        correlationId: input.correlationId,
        actorType: 'feishu_user',
        actorId: input.actorId,
        action: 'budget.reserve',
        resourceType: 'task',
        resourceId: input.taskId,
        outcome: 'denied',
        details: { violations: reservation.violations },
      });
      throw new BudgetExceededError(reservation.violations);
    }
    return { limitsApplied: reservation.limitsApplied };
  }

  public async appendAuditEvent(input: {
    correlationId: string;
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    outcome: string;
    details?: Record<string, unknown>;
    retentionDays?: number;
  }): Promise<void> {
    await insertAudit(this.sql, input);
  }

  public async exportAuditEvents(input: {
    from: string;
    to: string;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const limit = input.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Audit export limit must be between 1 and 10000.');
    }
    const rows = await this.sql<AuditRow[]>`
      SELECT
        id,
        correlation_id,
        actor_type,
        actor_id,
        action,
        resource_type,
        resource_id,
        outcome,
        details,
        created_at,
        expires_at
      FROM audit_events
      WHERE created_at >= ${input.from}
        AND created_at < ${input.to}
      ORDER BY created_at, id
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: String(row.id),
      correlationId: row.correlation_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      ...(row.resource_id ? { resourceId: row.resource_id } : {}),
      outcome: row.outcome,
      details: row.details,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  }

  public async purgeExpiredAuditEvents(now = new Date().toISOString()): Promise<number> {
    const rows = await this.sql<{ id: string | number }[]>`
      DELETE FROM audit_events
      WHERE expires_at <= ${now}
      RETURNING id
    `;
    return rows.length;
  }

  public async upsertCredentialReference(input: CredentialReference): Promise<void> {
    const reference = CredentialReferenceSchema.parse(input);
    await this.sql`
      INSERT INTO credential_references (name, provider, target)
      VALUES (${reference.name}, ${reference.provider}, ${reference.target})
      ON CONFLICT (name) DO UPDATE SET
        provider = EXCLUDED.provider,
        target = EXCLUDED.target,
        updated_at = now()
    `;
  }

  public async getCredentialReference(name: string): Promise<CredentialReference | undefined> {
    const rows = await this.sql<
      Array<{ name: string; provider: CredentialReference['provider']; target: string }>
    >`
      SELECT name, provider, target
      FROM credential_references
      WHERE name = ${name}
    `;
    return rows[0] ? CredentialReferenceSchema.parse(rows[0]) : undefined;
  }
}

async function selectOperation(
  sql: GovernanceSql,
  operationId: string,
): Promise<OperationRow | undefined> {
  const rows = await sql<OperationRow[]>`
    SELECT ${operationColumns(sql)}
    FROM governed_operations
    WHERE id = ${operationId}
  `;
  return rows[0];
}

async function selectApproval(
  sql: GovernanceSql,
  approvalId: string,
): Promise<ApprovalRecord | undefined> {
  const rows = await sql<ApprovalRow[]>`
    SELECT ${approvalColumns(sql)}
    FROM approval_requests
    WHERE id = ${approvalId}
  `;
  return rows[0] ? mapApproval(rows[0]) : undefined;
}

function operationColumns(sql: GovernanceSql) {
  return sql`
    id,
    task_id,
    requested_by,
    chat_id,
    tool_name,
    operation,
    risk,
    resource_type,
    resource_id,
    idempotency_key,
    request_hash,
    status,
    approval_request_id,
    execution_claim_token,
    expires_at,
    executed_at,
    finished_at
  `;
}

function approvalColumns(sql: GovernanceSql) {
  return sql`
    id,
    task_id,
    operation_id,
    requested_by,
    decided_by,
    status,
    decision_reason,
    expires_at,
    decided_at,
    version
  `;
}

function mapOperation(row: OperationRow): GovernedOperationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    requestedBy: row.requested_by,
    chatId: row.chat_id,
    toolName: row.tool_name,
    operation: row.operation,
    riskLevel: row.risk,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.approval_request_id ? { approvalRequestId: row.approval_request_id } : {}),
    ...(row.execution_claim_token ? { executionClaimToken: row.execution_claim_token } : {}),
    expiresAt: row.expires_at.toISOString(),
    ...(row.executed_at ? { executedAt: row.executed_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    operationId: row.operation_id,
    requestedBy: row.requested_by,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    status: row.status,
    ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
    expiresAt: row.expires_at.toISOString(),
    ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
    version: row.version,
  };
}

function approvalToOperationStatus(status: ApprovalStatus): GovernedOperationStatus {
  const statuses: Record<ApprovalStatus, GovernedOperationStatus> = {
    pending: 'pending_approval',
    approved: 'approved',
    rejected: 'rejected',
    expired: 'expired',
    revoked: 'revoked',
  };
  return statuses[status];
}

async function insertAudit(
  sql: GovernanceSql,
  input: {
    correlationId: string;
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    outcome: string;
    details?: Record<string, unknown>;
    retentionDays?: number;
  },
): Promise<void> {
  const retentionDays = input.retentionDays ?? 365;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error('Audit retention days must be between 1 and 3650.');
  }
  const expiresAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
  const details = redactAuditDetails(input.details ?? {}) as Record<string, unknown>;
  await sql`
    INSERT INTO audit_events (
      correlation_id,
      actor_type,
      actor_id,
      action,
      resource_type,
      resource_id,
      outcome,
      details,
      expires_at,
      redacted
    ) VALUES (
      ${input.correlationId},
      ${input.actorType},
      ${input.actorId},
      ${input.action},
      ${input.resourceType},
      ${input.resourceId ?? null},
      ${input.outcome},
      ${sql.json(toJsonValue(details))},
      ${expiresAt},
      true
    )
  `;
}

function uniqueScopes(
  scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }>,
): Array<{ scopeType: BudgetScopeType; scopeId: string }> {
  const result = new Map<string, { scopeType: BudgetScopeType; scopeId: string }>();
  for (const scope of scopes) {
    if (!scope.scopeId.trim()) {
      throw new Error('Budget scope identifier must not be empty.');
    }
    result.set(`${scope.scopeType}:${scope.scopeId}`, scope);
  }
  return [...result.values()].sort((left, right) =>
    `${left.scopeType}:${left.scopeId}`.localeCompare(`${right.scopeType}:${right.scopeId}`),
  );
}

function budgetWindowKey(
  period: BudgetLimit['period'],
  taskId: string,
  occurredAt: string,
): string {
  if (period === 'task') {
    return taskId;
  }
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid budget timestamp: ${occurredAt}`);
  }
  const iso = date.toISOString();
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

function safeInteger(value: string | number, name: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function assertNoInlineSecrets(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(authorization|cookie|password|secret|token|credential|private[-_]?key)/i.test(key)) {
        throw new GovernanceConflictError(
          'INLINE_SECRET_FORBIDDEN',
          `Governed operation payload must use a credential reference instead of ${path}.${key}.`,
        );
      }
      assertNoInlineSecrets(item, `${path}.${key}`);
    }
  }
}

function toJsonValue(value: unknown): never {
  return value as never;
}
