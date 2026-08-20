import type { RiskLevel, TaskStatus } from '@feishu-agent/contracts';

const transitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['running', 'cancelled', 'expired']),
  running: new Set(['waiting_approval', 'succeeded', 'failed', 'cancelled', 'expired']),
  waiting_approval: new Set(['running', 'failed', 'cancelled', 'expired']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].has(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export interface OperationPolicyInput {
  operation: 'read' | 'write';
  riskLevel: RiskLevel;
}

export function requiresApproval({ operation, riskLevel }: OperationPolicyInput): boolean {
  if (operation === 'read') {
    return false;
  }

  return riskLevel === 'high' || riskLevel === 'critical';
}
