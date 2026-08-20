import type { ExecutorErrorCategory, ExecutorFailure } from '@feishu-agent/contracts';

export class ExecutorRuntimeError extends Error {
  public constructor(
    public readonly category: ExecutorErrorCategory,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecutorRuntimeError';
  }

  public toFailure(): ExecutorFailure {
    return {
      category: this.category,
      code: this.code,
      message: this.message.slice(0, 2_000),
      retryable: this.retryable,
    };
  }
}

export function classifyExecutorError(error: unknown): ExecutorRuntimeError {
  if (error instanceof ExecutorRuntimeError) {
    return error;
  }
  if (isAbortError(error)) {
    return new ExecutorRuntimeError(
      'cancelled',
      'EXECUTOR_CANCELLED',
      'Execution was cancelled.',
      false,
      {
        cause: error,
      },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = readNumericProperty(error, 'status');
  if (status === 429) {
    return new ExecutorRuntimeError('rate_limited', 'DEPENDENCY_RATE_LIMITED', message, true, {
      cause: error,
    });
  }
  if (status === 401 || status === 403) {
    return new ExecutorRuntimeError('unauthorized', 'DEPENDENCY_AUTH_FAILED', message, false, {
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new ExecutorRuntimeError('dependency', 'DEPENDENCY_SERVER_ERROR', message, true, {
      cause: error,
    });
  }
  const code = readStringProperty(error, 'code');
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)) {
    return new ExecutorRuntimeError('dependency', 'DEPENDENCY_CONNECTION_FAILED', message, true, {
      cause: error,
    });
  }
  return new ExecutorRuntimeError(
    'internal',
    'EXECUTOR_INTERNAL',
    message || 'Unknown executor failure.',
    true,
    { cause: error },
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const reason = signal.reason as unknown;
  if (reason instanceof ExecutorRuntimeError) {
    throw reason;
  }
  throw new ExecutorRuntimeError(
    'cancelled',
    'EXECUTOR_CANCELLED',
    'Execution was cancelled.',
    false,
    reason instanceof Error ? { cause: reason } : undefined,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TaskCancelledError')
  );
}

function readNumericProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'number' ? property : undefined;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}
