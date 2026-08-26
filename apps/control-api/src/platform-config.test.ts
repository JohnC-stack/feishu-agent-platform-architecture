import { describe, expect, it } from 'vitest';

import {
  defaultManagedConfiguration,
  managedConfigChecksum,
  validateManagedConfiguration,
} from './platform-config.js';

describe('managed platform configuration', () => {
  it('normalizes missing values to safe defaults and produces a stable checksum', () => {
    const first = validateManagedConfiguration({ 'alerts.queueWaitingThreshold': 25 });
    const second = validateManagedConfiguration({
      ...defaultManagedConfiguration(),
      'alerts.queueWaitingThreshold': 25,
    });

    expect(first.valid).toBe(true);
    expect(first.warnings.length).toBeGreaterThan(0);
    expect(first.configuration).toEqual(second.configuration);
    expect(managedConfigChecksum(first.configuration)).toBe(
      managedConfigChecksum(second.configuration),
    );
    expect(managedConfigChecksum(first.configuration)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects out-of-range, non-integer and unknown values', () => {
    const result = validateManagedConfiguration({
      'alerts.queueWaitingThreshold': 0,
      'alerts.budgetPercentThreshold': 90.5,
      'unknown.setting': 1,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('队列积压告警阈值'),
        expect.stringContaining('预算占用告警阈值'),
        expect.stringContaining('unknown.setting'),
      ]),
    );
  });

  it('reports secret-like keys as prohibited database material', () => {
    const result = validateManagedConfiguration({
      DATABASE_URL: 'postgres://never-store',
      gitlabToken: 'never-store',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((message) => message.includes('敏感信息'))).toBe(true);
  });
});
