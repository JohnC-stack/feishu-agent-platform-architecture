import type { TaskRequest } from '@feishu-agent/contracts';
import type { ZodType } from 'zod';

import { ExecutorRuntimeError, throwIfAborted } from './errors.js';

export type ToolOperation = 'read' | 'write';

export interface ToolExecutionContext {
  task: TaskRequest;
  signal: AbortSignal;
}

export interface ToolDefinition<TArguments = unknown> {
  name: string;
  description: string;
  operation: ToolOperation;
  parameters: Record<string, unknown>;
  schema: ZodType<TArguments>;
  execute(arguments_: TArguments, context: ToolExecutionContext): unknown;
}

export interface ToolInvocationResult {
  toolName: string;
  operation: ToolOperation;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface ToolDescriptor {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export class ToolGateway {
  private readonly definitions = new Map<string, ToolDefinition>();

  public constructor(
    definitions: readonly ToolDefinition[] = [],
    private readonly maxResultCharacters = 20_000,
  ) {
    if (!Number.isInteger(maxResultCharacters) || maxResultCharacters < 100) {
      throw new Error('Tool result limit must be an integer of at least 100 characters.');
    }
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  public register(definition: ToolDefinition): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(definition.name)) {
      throw new Error(`Invalid tool name: ${definition.name}`);
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`Duplicate tool registration: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  public describeApprovedTools(approvedToolNames: ReadonlySet<string>): ToolDescriptor[] {
    return [...approvedToolNames]
      .map((name) => this.definitions.get(name))
      .filter((definition): definition is ToolDefinition => definition !== undefined)
      .map((definition) => ({
        type: 'function',
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        strict: true,
      }));
  }

  public async invoke(
    toolName: string,
    rawArguments: unknown,
    approvedToolNames: ReadonlySet<string>,
    context: ToolExecutionContext,
  ): Promise<ToolInvocationResult> {
    throwIfAborted(context.signal);
    if (!approvedToolNames.has(toolName)) {
      throw new ExecutorRuntimeError(
        'unauthorized',
        'TOOL_NOT_APPROVED',
        `Tool is not approved for this task: ${toolName}`,
        false,
      );
    }
    const definition = this.definitions.get(toolName);
    if (!definition) {
      throw new ExecutorRuntimeError(
        'dependency',
        'TOOL_NOT_REGISTERED',
        `Approved tool is not registered: ${toolName}`,
        false,
      );
    }
    const parsed = definition.schema.safeParse(rawArguments);
    if (!parsed.success) {
      throw new ExecutorRuntimeError(
        'validation',
        'TOOL_ARGUMENTS_INVALID',
        `Tool arguments failed validation: ${toolName}`,
        false,
      );
    }
    const startedAt = performance.now();
    try {
      const result = await definition.execute(parsed.data, context);
      throwIfAborted(context.signal);
      const serialized = serializeToolOutput(result);
      const truncated = serialized.length > this.maxResultCharacters;
      return {
        toolName,
        operation: definition.operation,
        output: truncated
          ? `${serialized.slice(0, this.maxResultCharacters)}...[truncated]`
          : serialized,
        truncated,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error: unknown) {
      if (error instanceof ExecutorRuntimeError) {
        throw error;
      }
      throw new ExecutorRuntimeError(
        'tool',
        'TOOL_EXECUTION_FAILED',
        `Tool execution failed: ${toolName}`,
        true,
        { cause: error },
      );
    }
  }
}

function serializeToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error: unknown) {
    throw new ExecutorRuntimeError(
      'tool',
      'TOOL_RESULT_NOT_SERIALIZABLE',
      'Tool result could not be serialized.',
      false,
      { cause: error },
    );
  }
}
