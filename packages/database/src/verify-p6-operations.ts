import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { AdminRepository } from './admin-repository.js';
import { GovernanceRepository } from './governance-repository.js';
import { createDatabaseClient } from './index.js';

export async function verifyP6Operations(): Promise<Record<string, boolean>> {
  const sql = createDatabaseClient();
  const repository = new AdminRepository(sql);
  const governanceRepository = new GovernanceRepository(sql);
  const taskId = randomUUID();
  const correlationId = `p6-verify-${randomUUID()}`;
  const alertKey = `p6-verify:${randomUUID()}`;
  const releaseId = randomUUID();
  const backupId = randomUUID();
  const configId = randomUUID();
  const managedPrincipalId = `verify-managed-${randomUUID()}`;
  const protectedPrincipalId = `verify-bootstrap-${randomUUID()}`;
  let operationId: string | undefined;
  try {
    await sql`
      INSERT INTO tasks (
        id,
        source_event_id,
        correlation_id,
        reply_target_id,
        status,
        risk,
        input,
        input_summary
      ) VALUES (
        ${taskId},
        ${`event-${correlationId}`},
        ${correlationId},
        ${`reply-${correlationId}`},
        'failed',
        'medium',
        ${sql.json({ text: 'P6 trace verification' })},
        'P6 trace verification'
      )
    `;
    await sql`
      INSERT INTO task_events (task_id, sequence, kind, message, payload)
      VALUES (${taskId}, 0, 'failed', 'Synthetic P6 trace event.', ${sql.json({ phase: 'P6' })})
    `;
    await repository.reconcileAlerts([
      {
        key: alertKey,
        severity: 'warning',
        category: 'verification',
        title: 'P6 verification alert',
        message: 'Synthetic non-production verification alert.',
        source: 'verify:p6',
        correlationId,
        details: { synthetic: true },
      },
    ]);
    const createdSnapshot = await repository.getSnapshot(200);
    const alert = createdSnapshot.alerts.find((item) => item.key === alertKey);
    const alertCreated = alert?.status === 'open';
    const alertAcknowledged = alert
      ? await repository.acknowledgeAlert(alert.id, 'p6-verifier')
      : false;

    const operation = await repository.createOperation({
      action: 'cancel',
      targetType: 'task',
      targetId: taskId,
      riskLevel: 'medium',
      requestedBy: 'p6-verifier',
      confirmation: `确认取消任务:${taskId}`,
      status: 'executing',
    });
    operationId = operation.id;
    const finished = await repository.finishOperation({
      operationId: operation.id,
      status: 'succeeded',
      result: { synthetic: true },
    });

    await sql`
      INSERT INTO platform_releases (
        id, version, commit_sha, environment, status, created_by, deployed_at
      ) VALUES (
        ${releaseId}, 'p6-verification', 'synthetic', 'verification', 'deployed',
        'p6-verifier', now()
      )
    `;
    await sql`
      INSERT INTO platform_backups (
        id, backup_type, status, storage_reference, encrypted, checksum, created_by,
        completed_at, restore_verified_at
      ) VALUES (
        ${backupId}, 'configuration', 'completed', 'verification-only', true,
        'synthetic-checksum', 'p6-verifier', now(), now()
      )
    `;
    const nextVersions = await sql<Array<{ version: number }>>`
      SELECT coalesce(max(version), 0)::int + 1 AS version
      FROM platform_config_versions
    `;
    const configVersion = nextVersions[0]?.version ?? 1;
    await sql`
      INSERT INTO platform_config_versions (
        id, version, checksum, status, configuration, created_by, activated_at
      ) VALUES (
        ${configId}, ${configVersion}, 'synthetic-checksum', 'active',
        ${sql.json({ apiAgentEnabled: false, secretsStored: false })},
        'p6-verifier', now()
      )
    `;

    const managedBinding = {
      principalType: 'user' as const,
      principalId: managedPrincipalId,
      roleId: 'reader',
    };
    const protectedBinding = {
      principalType: 'user' as const,
      principalId: protectedPrincipalId,
      roleId: 'administrator',
    };
    await governanceRepository.upsertRoleBinding(managedBinding, 'admin-console');
    await governanceRepository.upsertRoleBinding(protectedBinding, 'bootstrap');
    const policyWithBindings = await governanceRepository.getPolicySnapshot();
    const managedRoleBindingVisible = policyWithBindings.bindings.some(
      (binding) =>
        binding.principalId === managedPrincipalId && binding.roleId === managedBinding.roleId,
    );
    const managedRoleBindingDeleted =
      (await governanceRepository.deleteRoleBinding(managedBinding)) === 'deleted';
    const bootstrapRoleBindingProtected =
      (await governanceRepository.deleteRoleBinding(protectedBinding)) === 'protected';

    const snapshot = await repository.getSnapshot(200);
    const trace = await repository.getTaskTrace(taskId);
    const acknowledged = snapshot.alerts.find((item) => item.key === alertKey);
    return {
      snapshotAggregatesTasks: (snapshot.taskCounts.failed ?? 0) >= 1,
      taskTraceLinksEvent: trace?.taskEvents.length === 1,
      alertCreated,
      alertAcknowledged,
      alertStatePersisted: acknowledged?.status === 'acknowledged',
      adminOperationAuditable: finished.status === 'succeeded',
      releaseVisible: snapshot.releases.some((item) => item.id === releaseId),
      backupVisible: snapshot.backups.some((item) => item.id === backupId),
      configVersionVisible: snapshot.configVersions.some((item) => item.id === configId),
      configurationContainsNoSecrets:
        JSON.stringify(snapshot.configVersions).includes('secretsStored') &&
        !JSON.stringify(snapshot.configVersions).includes('password'),
      managedRoleBindingVisible,
      managedRoleBindingDeleted,
      bootstrapRoleBindingProtected,
    };
  } finally {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM operational_alerts WHERE alert_key = ${alertKey}`;
      if (operationId) {
        await transaction`DELETE FROM admin_operations WHERE id = ${operationId}`;
      }
      await transaction`DELETE FROM platform_releases WHERE id = ${releaseId}`;
      await transaction`DELETE FROM platform_backups WHERE id = ${backupId}`;
      await transaction`DELETE FROM platform_config_versions WHERE id = ${configId}`;
      await transaction`
        DELETE FROM governance_role_bindings
        WHERE principal_id IN (${managedPrincipalId}, ${protectedPrincipalId})
      `;
      await transaction`DELETE FROM tasks WHERE id = ${taskId}`;
    });
    await sql.end();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  verifyP6Operations()
    .then((checks) => {
      const failed = Object.entries(checks).filter(([, value]) => !value);
      console.log(JSON.stringify(checks, null, 2));
      if (failed.length > 0) {
        throw new Error(
          `P6 database verification failed: ${failed.map(([key]) => key).join(', ')}`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
