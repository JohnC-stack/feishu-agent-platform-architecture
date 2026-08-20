import type { ExecutorKind } from '@feishu-agent/contracts';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetAfterMs?: number;
  now?: () => number;
}

interface CircuitState {
  failures: number;
  openedAt?: number;
}

export class ExecutorCircuitBreaker {
  private readonly states = new Map<ExecutorKind, CircuitState>();
  private readonly failureThreshold: number;
  private readonly resetAfterMs: number;
  private readonly now: () => number;

  public constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetAfterMs = options.resetAfterMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new Error('Circuit breaker failure threshold must be a positive integer.');
    }
    if (!Number.isInteger(this.resetAfterMs) || this.resetAfterMs < 1) {
      throw new Error('Circuit breaker reset time must be a positive integer.');
    }
  }

  public canExecute(kind: ExecutorKind): boolean {
    const state = this.states.get(kind);
    if (!state?.openedAt) {
      return true;
    }
    if (this.now() - state.openedAt >= this.resetAfterMs) {
      this.states.set(kind, { failures: this.failureThreshold - 1 });
      return true;
    }
    return false;
  }

  public recordSuccess(kind: ExecutorKind): void {
    this.states.delete(kind);
  }

  public recordFailure(kind: ExecutorKind): void {
    const previous = this.states.get(kind) ?? { failures: 0 };
    const failures = previous.failures + 1;
    this.states.set(kind, {
      failures,
      ...(failures >= this.failureThreshold ? { openedAt: this.now() } : {}),
    });
  }

  public snapshot(kind: ExecutorKind): { state: 'closed' | 'open'; failures: number } {
    const state = this.states.get(kind) ?? { failures: 0 };
    return { state: state.openedAt ? 'open' : 'closed', failures: state.failures };
  }
}
