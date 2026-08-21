import { createHash, randomUUID } from 'node:crypto';

import { TaskRequestSchema, type GovernedOperationRequest } from '@feishu-agent/contracts';
import { RbacPolicy, defaultGovernanceRoles } from '@feishu-agent/policy';

import { createDatabaseClient } from './index.js';
import {
  BudgetExceededError,
  GovernanceConflictError,
  GovernanceRepository,
} from './governance-repository.js';
import { TaskRepository } from './task-repository.js';

async function main(): Promise<void> {
  const sql = createDatabaseClient();
  const governance = new GovernanceRepository(sql);
  const tasks = new TaskRepository(sql);
  const suffix = randomUUID();
  const taskId = randomUUID();
  const requester = `p5-requester-${suffix}`;
  const approver = `p5-approver-${suffix}`;
  const managedBy = `p5-verification-${suffix}`;
  const correlationId = `p5-verification-${suffix}`;
  const credentialName = `p5-verification-${suffix}`;
  const budgetScopeId = `p5-budget-${suffix}`;

  try {
    await governance.seedPolicy(
      defaultGovernanceRoles,
      [
        { principalType: 'user', principalId: requester, roleId: 'operator' },
        { principalType: 'user', principalId: approver, roleId: 'approver' },
      ],
      managedBy,
    );
    const snapshot = await governance.getPolicySnapshot();
    const policy = new RbacPolicy(snapshot.roles, snapshot.bindings);
    assert(
      policy.authorizeTool({
        userId: requester,
        toolName: 'agent_cli.execute',
        resourceType: 'workspace',
        resourceId: 'D:/Codex/coding',
      }).allowed,
      'Persisted operator binding did not authorize the write tool.',
    );
    assert(
      !policy.authorizeTool({ userId: 'p5-unknown', toolName: 'platform.health' }).allowed,
      'Unknown principal unexpectedly received tool access.',
    );

    const request = TaskRequestSchema.parse({
      id: taskId,
      source: {
        channel: 'feishu',
        eventId: `event-${suffix}`,
        chatId: `chat-${suffix}`,
        userId: requester,
        replyTargetId: `message-${suffix}`,
      },
      input: { text: '/code p5 synthetic write', attachments: [] },
      requestedExecutor: 'agent_cli',
      riskLevel: 'critical',
      correlationId,
      createdAt: new Date().toISOString(),
      metadata: { workspacePath: 'D:/Codex/coding' },
    });
    await tasks.createTask({
      request,
      route: {
        executor: 'agent_cli',
        ruleId: 'p5-verification',
        ruleVersion: 1,
        reason: 'P5 database governance verification.',
      },
      maxAttempts: 1,
    });

    const firstRequest = createOperation({ taskId, requester, suffix, sequence: 1 });
    const created = await governance.createGovernedOperation(firstRequest);
    assert(created.created, 'The first governed operation was not created.');
    assert(
      created.operation.status === 'pending_approval',
      'Critical write did not wait for approval.',
    );
    assert(created.approval?.status === 'pending', 'Approval request was not pending.');

    const beforeApproval = await governance.claimOperationExecution(firstRequest.id);
    assert(!beforeApproval.claimed, 'Operation executed before approval.');

    const duplicate = await governance.createGovernedOperation({
      ...firstRequest,
      id: randomUUID(),
    });
    assert(!duplicate.created, 'Identical idempotent operation was inserted twice.');
    assert(
      duplicate.operation.id === firstRequest.id,
      'Duplicate did not resolve to the original operation.',
    );

    let mismatchRejected = false;
    try {
      await governance.createGovernedOperation({
        ...firstRequest,
        id: randomUUID(),
        requestHash: 'f'.repeat(64),
      });
    } catch (error: unknown) {
      mismatchRejected =
        error instanceof GovernanceConflictError && error.code === 'IDEMPOTENCY_KEY_REUSED';
    }
    assert(mismatchRejected, 'Reused idempotency key with a different payload was not rejected.');

    let selfApprovalRejected = false;
    try {
      await governance.decideApproval({
        approvalId: created.approval?.id ?? '',
        actorId: requester,
        action: 'approve',
      });
    } catch (error: unknown) {
      selfApprovalRejected =
        error instanceof Error && error.message.includes('cannot approve or reject their own');
    }
    assert(selfApprovalRejected, 'Separation of duties did not reject self approval.');

    const approved = await governance.decideApproval({
      approvalId: created.approval?.id ?? '',
      actorId: approver,
      action: 'approve',
      reason: 'Synthetic P5 verification approval.',
    });
    assert(
      approved.operation.status === 'approved',
      'Approved operation did not become executable.',
    );

    const claims = await Promise.all([
      governance.claimOperationExecution(firstRequest.id),
      governance.claimOperationExecution(firstRequest.id),
    ]);
    const winningClaims = claims.filter((claim) => claim.claimed);
    assert(winningClaims.length === 1, 'Concurrent execution claim was not exactly-once.');
    const winner = winningClaims[0];
    assert(winner?.operation.executionClaimToken, 'Winning claim did not receive a claim token.');
    const completed = await governance.completeOperation({
      operationId: firstRequest.id,
      claimToken: winner?.operation.executionClaimToken ?? '',
      outcome: 'succeeded',
      resultReference: 'p5-verification:synthetic',
    });
    assert(completed.status === 'succeeded', 'Claimed operation did not complete.');
    const replay = await governance.claimOperationExecution(firstRequest.id);
    assert(!replay.claimed, 'Completed operation was claimed a second time.');

    const revokeRequest = createOperation({ taskId, requester, suffix, sequence: 2 });
    const revokeCreated = await governance.createGovernedOperation(revokeRequest);
    const revokeApproved = await governance.decideApproval({
      approvalId: revokeCreated.approval?.id ?? '',
      actorId: approver,
      action: 'approve',
    });
    const revoked = await governance.decideApproval({
      approvalId: revokeApproved.approval.id,
      actorId: approver,
      action: 'revoke',
      reason: 'Synthetic revocation before execution.',
    });
    assert(revoked.operation.status === 'revoked', 'Approved operation was not revoked.');
    assert(
      !(await governance.claimOperationExecution(revokeRequest.id)).claimed,
      'Revoked operation was executable.',
    );

    const rejectRequest = createOperation({ taskId, requester, suffix, sequence: 3 });
    const rejectCreated = await governance.createGovernedOperation(rejectRequest);
    const rejected = await governance.decideApproval({
      approvalId: rejectCreated.approval?.id ?? '',
      actorId: approver,
      action: 'reject',
      reason: 'Synthetic rejection.',
    });
    assert(rejected.operation.status === 'rejected', 'Rejected operation had the wrong status.');
    assert(
      !(await governance.claimOperationExecution(rejectRequest.id)).claimed,
      'Rejected operation was executable.',
    );

    const expiryRequest = {
      ...createOperation({ taskId, requester, suffix, sequence: 4 }),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const expiryCreated = await governance.createGovernedOperation(expiryRequest);
    const expired = await governance.decideApproval({
      approvalId: expiryCreated.approval?.id ?? '',
      actorId: approver,
      action: 'approve',
    });
    assert(expired.operation.status === 'expired', 'Expired approval was not closed as expired.');
    assert(
      !(await governance.claimOperationExecution(expiryRequest.id)).claimed,
      'Expired operation was executable.',
    );

    await governance.upsertBudgetLimit({
      scopeType: 'user',
      scopeId: budgetScopeId,
      period: 'day',
      tokenLimit: 100,
      costLimitMicros: 1_000,
    });
    await governance.reserveBudget({
      taskId,
      correlationId,
      actorId: requester,
      scopes: [{ scopeType: 'user', scopeId: budgetScopeId }],
      tokens: 60,
      costMicros: 100,
    });
    let budgetRejected = false;
    try {
      await governance.reserveBudget({
        taskId,
        correlationId,
        actorId: requester,
        scopes: [{ scopeType: 'user', scopeId: budgetScopeId }],
        tokens: 50,
        costMicros: 100,
      });
    } catch (error: unknown) {
      budgetRejected = error instanceof BudgetExceededError;
    }
    assert(budgetRejected, 'Budget overrun was not rejected.');

    await governance.appendAuditEvent({
      correlationId,
      actorType: 'verification',
      actorId: requester,
      action: 'p5.redaction.verify',
      resourceType: 'verification',
      resourceId: suffix,
      outcome: 'success',
      details: {
        authorization: `Bearer ${['synthetic', 'sensitive', 'value'].join('-')}`,
        nested: { password: ['synthetic', 'password'].join('-') },
      },
      retentionDays: 1,
    });
    const exported = await governance.exportAuditEvents({
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      limit: 10_000,
    });
    const redaction = exported.find((event) => event.action === 'p5.redaction.verify');
    assert(redaction, 'Redaction audit event was not exportable.');
    assert(
      !JSON.stringify(redaction).includes('synthetic-sensitive-value') &&
        JSON.stringify(redaction).includes('[REDACTED]'),
      'Audit export exposed sensitive content.',
    );

    await governance.upsertCredentialReference({
      name: credentialName,
      provider: 'windows_credential_manager',
      target: `FeishuAgent/P5Verification/${suffix}`,
    });
    const credentialReference = await governance.getCredentialReference(credentialName);
    assert(
      credentialReference?.target === `FeishuAgent/P5Verification/${suffix}`,
      'Credential reference metadata was not persisted.',
    );

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          checks: {
            persistedRbac: true,
            unauthorizedHidden: true,
            approvalRequired: true,
            separationOfDuties: true,
            idempotencyConflict: true,
            exactlyOnceClaim: true,
            rejection: true,
            expiration: true,
            revocation: true,
            hierarchicalBudget: true,
            redactedAuditExport: true,
            credentialReferenceOnly: true,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM audit_events WHERE correlation_id = ${correlationId}`;
      await transaction`
        DELETE FROM budget_usage
        WHERE scope_type = 'user' AND scope_id = ${budgetScopeId}
      `;
      await transaction`
        DELETE FROM budget_limits
        WHERE scope_type = 'user' AND scope_id = ${budgetScopeId}
      `;
      await transaction`DELETE FROM credential_references WHERE name = ${credentialName}`;
      await transaction`DELETE FROM governance_role_bindings WHERE managed_by = ${managedBy}`;
      await transaction`DELETE FROM tasks WHERE id = ${taskId}`;
    });
    await sql.end();
  }
}

function createOperation(input: {
  taskId: string;
  requester: string;
  suffix: string;
  sequence: number;
}): GovernedOperationRequest {
  const payload = { command: `synthetic-write-${input.sequence}` };
  return {
    id: randomUUID(),
    taskId: input.taskId,
    requestedBy: input.requester,
    chatId: `chat-${input.suffix}`,
    toolName: 'agent_cli.execute',
    operation: 'write',
    riskLevel: 'critical',
    resourceType: 'workspace',
    resourceId: 'D:/Codex/coding',
    idempotencyKey: `p5:${input.suffix}:${input.sequence}`,
    requestHash: createHash('sha256')
      .update(JSON.stringify({ ...payload, sequence: input.sequence }))
      .digest('hex'),
    payload,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
