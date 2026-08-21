export type IntegrationErrorCategory =
  | 'cancelled'
  | 'timeout'
  | 'validation'
  | 'unauthorized'
  | 'not_found'
  | 'dependency'
  | 'rate_limited'
  | 'remote'
  | 'malformed_response';

export class IntegrationError extends Error {
  public override readonly name = 'IntegrationError';

  public constructor(
    public readonly category: IntegrationErrorCategory,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function throwIfIntegrationAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new IntegrationError(
      'cancelled',
      'INTEGRATION_CANCELLED',
      'Integration request was cancelled.',
      false,
    );
  }
}
