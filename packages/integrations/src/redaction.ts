import type { BoundedIntegrationResult } from './types.js';

const sensitiveKey =
  /(?:authorization|cookie|credential|password|passwd|private[_-]?token|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|api[_-]?key|secret)/i;

const secretPatterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bglpat-[A-Za-z0-9_-]+\b/gi,
  /\b(?:t|u)-[A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:PRIVATE-TOKEN|JOB-TOKEN)\s*[:=]\s*\S+/gi,
];

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export function boundIntegrationResult(
  value: unknown,
  maxCharacters = 20_000,
): BoundedIntegrationResult {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 100) {
    throw new Error('Integration result limit must be an integer of at least 100 characters.');
  }
  const data = redactSensitive(value);
  const serialized = safeSerialize(data);
  if (serialized.length <= maxCharacters) {
    return { data, truncated: false, originalCharacters: serialized.length };
  }
  return {
    data: `${serialized.slice(0, maxCharacters)}...[truncated]`,
    truncated: true,
    originalCharacters: serialized.length,
  };
}

export function redactText(value: string): string {
  return secretPatterns.reduce((output, pattern) => output.replace(pattern, '[REDACTED]'), value);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? '[REDACTED]' : redactValue(child, seen);
  }
  return output;
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[Unserializable]"';
  }
}
