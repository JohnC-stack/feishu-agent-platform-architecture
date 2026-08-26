import { createHash } from 'node:crypto';

export const managedConfigCatalog = [
  {
    key: 'alerts.queueWaitingThreshold',
    group: '告警策略',
    label: '队列积压告警阈值',
    description: '等待任务数达到该值时生成队列积压告警。',
    minimum: 1,
    maximum: 100_000,
    defaultValue: 20,
    unit: '个',
  },
  {
    key: 'alerts.budgetPercentThreshold',
    group: '告警策略',
    label: '预算占用告警阈值',
    description: 'Token 预算占用达到该百分比时生成预算告警。',
    minimum: 1,
    maximum: 100,
    defaultValue: 80,
    unit: '%',
  },
  {
    key: 'alerts.failedTaskThreshold',
    group: '告警策略',
    label: '失败任务告警阈值',
    description: '查询范围内失败任务数达到该值时生成任务告警。',
    minimum: 1,
    maximum: 10_000,
    defaultValue: 1,
    unit: '个',
  },
  {
    key: 'alerts.modelFailureThreshold',
    group: '告警策略',
    label: '模型失败告警阈值',
    description: '查询范围内模型执行失败达到该值时生成严重告警。',
    minimum: 1,
    maximum: 1_000,
    defaultValue: 1,
    unit: '次',
  },
  {
    key: 'health.serviceProbeTimeoutMs',
    group: '健康检查',
    label: '服务探测超时',
    description: 'Control API 探测 Windows 服务和系统集成状态的最长等待时间。',
    minimum: 250,
    maximum: 30_000,
    defaultValue: 2_500,
    unit: 'ms',
  },
] as const;

export type ManagedConfigKey = (typeof managedConfigCatalog)[number]['key'];
export type ManagedConfiguration = Record<ManagedConfigKey, number>;

export interface ManagedConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  validatedAt: string;
}

export interface ManagedConfigValidationResult extends ManagedConfigValidation {
  configuration: ManagedConfiguration;
}

const sensitiveKeyPattern =
  /(secret|token|password|passwd|credential|private.?key|access.?key|database.?url|connection.?string|certificate|cookie|session)/iu;

export function defaultManagedConfiguration(): ManagedConfiguration {
  return Object.fromEntries(
    managedConfigCatalog.map((item) => [item.key, item.defaultValue]),
  ) as ManagedConfiguration;
}

export function validateManagedConfiguration(
  input: Record<string, unknown>,
  now = new Date(),
): ManagedConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const catalog = new Map(managedConfigCatalog.map((item) => [item.key, item]));
  const unknownKeys = Object.keys(input).filter((key) => !catalog.has(key as ManagedConfigKey));
  for (const key of unknownKeys) {
    errors.push(
      sensitiveKeyPattern.test(key)
        ? `配置键 ${key} 涉及敏感信息，禁止写入数据库。`
        : `配置键 ${key} 不在平台允许列表中。`,
    );
  }

  const configuration = defaultManagedConfiguration();
  for (const item of managedConfigCatalog) {
    const value = input[item.key];
    if (value === undefined) {
      warnings.push(`${item.label} 未提供，已使用默认值 ${item.defaultValue}${item.unit}。`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${item.label} 必须是整数。`);
      continue;
    }
    if (value < item.minimum || value > item.maximum) {
      errors.push(`${item.label} 必须在 ${item.minimum} 到 ${item.maximum}${item.unit} 之间。`);
      continue;
    }
    configuration[item.key] = value;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    validatedAt: now.toISOString(),
    configuration,
  };
}

export function managedConfigChecksum(configuration: ManagedConfiguration): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(configuration).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
