import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, requiresApproval } from './index.js';

describe('task state transitions', () => {
  it('allows approval to pause and resume a running task', () => {
    expect(canTransition('running', 'waiting_approval')).toBe(true);
    expect(canTransition('waiting_approval', 'running')).toBe(true);
  });

  it('does not allow terminal tasks to restart', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow(
      'Invalid task transition: succeeded -> running',
    );
  });
});

describe('operation approval policy', () => {
  it('requires approval for high-risk writes only', () => {
    expect(requiresApproval({ operation: 'write', riskLevel: 'high' })).toBe(true);
    expect(requiresApproval({ operation: 'read', riskLevel: 'critical' })).toBe(false);
    expect(requiresApproval({ operation: 'write', riskLevel: 'low' })).toBe(false);
  });
});
