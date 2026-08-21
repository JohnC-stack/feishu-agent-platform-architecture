import type { BudgetLimit, GovernanceRoleBinding } from '@feishu-agent/contracts';

export interface GovernanceConfig {
  bindings: GovernanceRoleBinding[];
  approvalTtlSeconds: number;
  auditRetentionDays: number;
  budgetDefaults: {
    userDaily: Pick<BudgetLimit, 'tokenLimit' | 'costLimitMicros'>;
    groupDaily: Pick<BudgetLimit, 'tokenLimit' | 'costLimitMicros'>;
    task: Pick<BudgetLimit, 'tokenLimit' | 'costLimitMicros'>;
    modelDaily: Pick<BudgetLimit, 'tokenLimit' | 'costLimitMicros'>;
  };
}

export function readGovernanceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GovernanceConfig {
  const administratorIds = readList(environment.GOVERNANCE_ADMIN_USER_IDS);
  if (administratorIds.length === 0) {
    throw new Error('GOVERNANCE_ADMIN_USER_IDS must contain at least one bootstrap administrator.');
  }
  const bindings: GovernanceRoleBinding[] = [];
  addBindings(bindings, 'user', administratorIds, 'administrator');
  addBindings(bindings, 'user', readList(environment.GOVERNANCE_READER_USER_IDS), 'reader');
  addBindings(bindings, 'user', readList(environment.GOVERNANCE_OPERATOR_USER_IDS), 'operator');
  addBindings(bindings, 'user', readList(environment.GOVERNANCE_APPROVER_USER_IDS), 'approver');
  addBindings(bindings, 'user', readList(environment.GOVERNANCE_AUDITOR_USER_IDS), 'auditor');
  addBindings(bindings, 'group', readList(environment.GOVERNANCE_READER_GROUP_IDS), 'reader');
  addBindings(bindings, 'group', readList(environment.GOVERNANCE_OPERATOR_GROUP_IDS), 'operator');
  addBindings(bindings, 'group', readList(environment.GOVERNANCE_APPROVER_GROUP_IDS), 'approver');
  addBindings(bindings, 'group', readList(environment.GOVERNANCE_AUDITOR_GROUP_IDS), 'auditor');
  return {
    bindings: uniqueBindings(bindings),
    approvalTtlSeconds: readPositiveInteger(
      environment.GOVERNANCE_APPROVAL_TTL_SECONDS,
      3_600,
      'GOVERNANCE_APPROVAL_TTL_SECONDS',
    ),
    auditRetentionDays: readPositiveInteger(
      environment.GOVERNANCE_AUDIT_RETENTION_DAYS,
      365,
      'GOVERNANCE_AUDIT_RETENTION_DAYS',
      3_650,
    ),
    budgetDefaults: {
      userDaily: {
        tokenLimit: readNonNegativeInteger(
          environment.GOVERNANCE_USER_DAILY_TOKEN_LIMIT,
          2_000_000,
          'GOVERNANCE_USER_DAILY_TOKEN_LIMIT',
        ),
        costLimitMicros: readNonNegativeInteger(
          environment.GOVERNANCE_USER_DAILY_COST_MICROS,
          100_000_000,
          'GOVERNANCE_USER_DAILY_COST_MICROS',
        ),
      },
      groupDaily: {
        tokenLimit: readNonNegativeInteger(
          environment.GOVERNANCE_GROUP_DAILY_TOKEN_LIMIT,
          10_000_000,
          'GOVERNANCE_GROUP_DAILY_TOKEN_LIMIT',
        ),
        costLimitMicros: readNonNegativeInteger(
          environment.GOVERNANCE_GROUP_DAILY_COST_MICROS,
          500_000_000,
          'GOVERNANCE_GROUP_DAILY_COST_MICROS',
        ),
      },
      task: {
        tokenLimit: readNonNegativeInteger(
          environment.GOVERNANCE_TASK_TOKEN_LIMIT,
          200_000,
          'GOVERNANCE_TASK_TOKEN_LIMIT',
        ),
        costLimitMicros: readNonNegativeInteger(
          environment.GOVERNANCE_TASK_COST_MICROS,
          20_000_000,
          'GOVERNANCE_TASK_COST_MICROS',
        ),
      },
      modelDaily: {
        tokenLimit: readNonNegativeInteger(
          environment.GOVERNANCE_MODEL_DAILY_TOKEN_LIMIT,
          20_000_000,
          'GOVERNANCE_MODEL_DAILY_TOKEN_LIMIT',
        ),
        costLimitMicros: readNonNegativeInteger(
          environment.GOVERNANCE_MODEL_DAILY_COST_MICROS,
          1_000_000_000,
          'GOVERNANCE_MODEL_DAILY_COST_MICROS',
        ),
      },
    },
  };
}

function addBindings(
  target: GovernanceRoleBinding[],
  principalType: GovernanceRoleBinding['principalType'],
  principalIds: string[],
  roleId: string,
): void {
  target.push(...principalIds.map((principalId) => ({ principalType, principalId, roleId })));
}

function uniqueBindings(bindings: GovernanceRoleBinding[]): GovernanceRoleBinding[] {
  return [
    ...new Map(
      bindings.map((binding) => [
        `${binding.principalType}:${binding.principalId}:${binding.roleId}`,
        binding,
      ]),
    ).values(),
  ];
}

function readList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = readNonNegativeInteger(value, fallback, name);
  if (parsed === 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function readNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}
