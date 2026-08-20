export interface ToolInvocation {
  taskId: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
  idempotencyKey?: string;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  retryable: boolean;
}

export interface ToolAdapter {
  readonly name: string;
  readonly access: 'read' | 'write';
  invoke(invocation: ToolInvocation, signal: AbortSignal): Promise<ToolResult>;
}
