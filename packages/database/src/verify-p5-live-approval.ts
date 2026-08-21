import { createDatabaseClient } from './index.js';

interface LiveApprovalRow {
  approval_status: string;
  operation_status: string;
  duties_separated: boolean;
  decision_recorded: boolean;
  version: number;
  audit_events: number;
}

async function main(): Promise<void> {
  const approvalId = process.env.P5_APPROVAL_ID?.trim();
  if (!approvalId) {
    throw new Error('P5_APPROVAL_ID is required.');
  }
  const sql = createDatabaseClient();
  try {
    const rows = await sql<LiveApprovalRow[]>`
      SELECT
        approval.status AS approval_status,
        operation.status AS operation_status,
        approval.requested_by <> approval.decided_by AS duties_separated,
        approval.decided_at IS NOT NULL AS decision_recorded,
        approval.version,
        COUNT(audit.id)::int AS audit_events
      FROM approval_requests approval
      JOIN governed_operations operation ON operation.id = approval.operation_id
      LEFT JOIN audit_events audit
        ON audit.resource_type = 'approval'
       AND audit.resource_id = approval.id::text
       AND audit.action = 'approval.approve'
      WHERE approval.id = ${approvalId}
      GROUP BY
        approval.status,
        operation.status,
        approval.requested_by,
        approval.decided_by,
        approval.decided_at,
        approval.version
    `;
    const row = rows[0];
    const checks = {
      approvalApproved: row?.approval_status === 'approved',
      operationApproved: row?.operation_status === 'approved',
      dutiesSeparated: row?.duties_separated === true,
      decisionRecorded: row?.decision_recorded === true,
      versionAdvanced: (row?.version ?? 0) >= 2,
      approvalAuditRecorded: (row?.audit_events ?? 0) >= 1,
    };
    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ status: ok ? 'ok' : 'failed', checks }, null, 2));
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

void main();
