import {
  ExecutorExecutionResultSchema,
  type ExecutorExecutionRequest,
  type ExecutorExecutionResult,
} from '@feishu-agent/contracts';

export class ExecutorWorkerClient {
  private readonly baseUrl: string;

  public constructor(baseUrl = process.env.WINDOWS_WORKER_URL ?? 'http://127.0.0.1:3200') {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('WINDOWS_WORKER_URL must use http:// or https://.');
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  public async execute(
    request: ExecutorExecutionRequest,
    signal: AbortSignal,
  ): Promise<ExecutorExecutionResult> {
    const abortHandler = (): void => {
      void this.cancel(request.task.id).catch(() => undefined);
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}/v1/executions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': request.task.correlationId,
        },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Windows Worker returned HTTP ${response.status}.`);
      }
      return ExecutorExecutionResultSchema.parse(await response.json());
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }
  }

  public async cancel(taskId: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/v1/executions/${taskId}/cancel`, {
      method: 'POST',
    });
    return response.status === 202;
  }

  public async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health/ready`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
