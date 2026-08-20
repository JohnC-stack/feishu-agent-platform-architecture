import OpenAI from 'openai';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import { ExecutorRuntimeError, throwIfAborted } from './errors.js';
import { createExecutorEvent } from './events.js';
import type { ToolDescriptor, ToolGateway } from './tool-gateway.js';
import type { Executor, ExecutorContext } from './types.js';

export interface ResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesOutputMessage {
  type: 'message';
  content?: Array<{ type: string; text?: string }>;
}

export interface ResponsesResponse {
  id: string;
  output: Array<ResponsesFunctionCall | ResponsesOutputMessage | Record<string, unknown>>;
  output_text?: string;
  usage?: Record<string, unknown>;
}

export interface ResponsesCreateRequest {
  model: string;
  instructions: string;
  input: string | Array<Record<string, unknown>>;
  tools: ToolDescriptor[];
  tool_choice: 'auto';
  parallel_tool_calls: boolean;
  max_output_tokens: number;
  previous_response_id?: string;
  store: true;
}

export interface ResponsesClient {
  create(request: ResponsesCreateRequest, signal: AbortSignal): Promise<ResponsesResponse>;
}

export class OpenAIResponsesClient implements ResponsesClient {
  private readonly client: OpenAI;

  public constructor(apiKey: string, baseURL?: string) {
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for ApiAgentExecutor.');
    }
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  public async create(
    request: ResponsesCreateRequest,
    signal: AbortSignal,
  ): Promise<ResponsesResponse> {
    const response = await this.client.responses.create(request as never, { signal });
    return response as unknown as ResponsesResponse;
  }
}

export interface ApiAgentExecutorOptions {
  model: string;
  instructions?: string;
  maxTurns?: number;
  maxInputCharacters?: number;
  maxOutputTokens?: number;
}

export class ApiAgentExecutor implements Executor {
  public readonly kind = 'api_agent' as const;
  private readonly instructions: string;
  private readonly maxTurns: number;
  private readonly maxInputCharacters: number;
  private readonly maxOutputTokens: number;

  public constructor(
    private readonly client: ResponsesClient,
    private readonly gateway: ToolGateway,
    private readonly options: ApiAgentExecutorOptions,
  ) {
    if (!options.model) {
      throw new Error('ApiAgentExecutor model is required.');
    }
    this.instructions =
      options.instructions ??
      'Complete the read-only task with only the provided tools. Never invent tool results.';
    this.maxTurns = readPositiveInteger(options.maxTurns, 6, 'maxTurns');
    this.maxInputCharacters = readPositiveInteger(
      options.maxInputCharacters,
      40_000,
      'maxInputCharacters',
    );
    this.maxOutputTokens = readPositiveInteger(options.maxOutputTokens, 4_000, 'maxOutputTokens');
  }

  public async *execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    throwIfAborted(context.signal);
    const approvedTools = this.gateway.describeApprovedTools(context.approvedToolNames);
    const { tools, internalNamesByApiName } = bindApiToolNames(approvedTools);
    let input: ResponsesCreateRequest['input'] = limitInput(
      [context.contextText, task.input.text].filter(Boolean).join('\n\n'),
      this.maxInputCharacters,
    );
    let previousResponseId: string | undefined;
    let sequence = 0;
    yield createExecutorEvent(
      task,
      context,
      this.kind,
      sequence++,
      'started',
      `Responses API agent started with ${tools.length} approved tools.`,
      { model: this.options.model, approvedTools: approvedTools.map(({ name }) => name) },
    );

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      throwIfAborted(context.signal);
      const response = await this.client.create(
        {
          model: this.options.model,
          instructions: this.instructions,
          input,
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          max_output_tokens: this.maxOutputTokens,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          store: true,
        },
        context.signal,
      );
      if (!response.id) {
        throw new ExecutorRuntimeError(
          'dependency',
          'RESPONSES_ID_MISSING',
          'Responses API returned no response identifier.',
          true,
        );
      }
      yield createExecutorEvent(
        task,
        context,
        this.kind,
        sequence++,
        'progress',
        `Responses API turn ${turn} completed.`,
        { model: this.options.model, responseId: response.id, turn, usage: response.usage ?? {} },
      );
      const calls = response.output.filter(isFunctionCall);
      if (calls.length === 0) {
        const output = readOutputText(response);
        if (!output) {
          throw new ExecutorRuntimeError(
            'dependency',
            'RESPONSES_OUTPUT_MISSING',
            'Responses API returned neither a tool call nor final text.',
            true,
          );
        }
        yield createExecutorEvent(
          task,
          context,
          this.kind,
          sequence,
          'completed',
          'Responses API agent completed.',
          {
            model: this.options.model,
            responseId: response.id,
            output,
            usage: response.usage ?? {},
          },
        );
        return;
      }

      const toolOutputs: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        throwIfAborted(context.signal);
        const internalToolName = internalNamesByApiName.get(call.name);
        if (!internalToolName) {
          throw new ExecutorRuntimeError(
            'unauthorized',
            'MODEL_TOOL_NOT_EXPOSED',
            `Model requested a tool that was not exposed for this task: ${call.name}`,
            false,
          );
        }
        yield createExecutorEvent(task, context, this.kind, sequence++, 'tool_call', undefined, {
          toolName: internalToolName,
          apiToolName: call.name,
          callId: call.call_id,
          responseId: response.id,
          turn,
        });
        const result = await this.gateway.invoke(
          internalToolName,
          parseToolArguments(call.arguments, internalToolName),
          context.approvedToolNames,
          { task, signal: context.signal },
        );
        yield createExecutorEvent(task, context, this.kind, sequence++, 'tool_result', undefined, {
          toolName: result.toolName,
          callId: call.call_id,
          operation: result.operation,
          durationMs: result.durationMs,
          truncated: result.truncated,
          output: result.output,
        });
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: result.output,
        });
      }
      input = toolOutputs;
      previousResponseId = response.id;
    }

    throw new ExecutorRuntimeError(
      'dependency',
      'REACT_TURN_LIMIT',
      `Responses API agent exceeded ${this.maxTurns} tool turns.`,
      false,
    );
  }
}

function bindApiToolNames(approvedTools: readonly ToolDescriptor[]): {
  tools: ToolDescriptor[];
  internalNamesByApiName: Map<string, string>;
} {
  const internalNamesByApiName = new Map<string, string>();
  const tools = approvedTools.map((tool) => {
    const apiName = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!apiName || apiName.length > 64) {
      throw new ExecutorRuntimeError(
        'validation',
        'API_TOOL_NAME_INVALID',
        `Tool name cannot be represented as an API function name: ${tool.name}`,
        false,
      );
    }
    const existing = internalNamesByApiName.get(apiName);
    if (existing && existing !== tool.name) {
      throw new ExecutorRuntimeError(
        'validation',
        'API_TOOL_NAME_COLLISION',
        `Tool names resolve to the same API function name: ${existing}, ${tool.name}`,
        false,
      );
    }
    internalNamesByApiName.set(apiName, tool.name);
    return { ...tool, name: apiName };
  });
  return { tools, internalNamesByApiName };
}

function isFunctionCall(value: unknown): value is ResponsesFunctionCall {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === 'function_call' &&
    typeof record.call_id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.arguments === 'string'
  );
}

function parseToolArguments(value: string, toolName: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new ExecutorRuntimeError(
      'validation',
      'MODEL_TOOL_ARGUMENTS_INVALID_JSON',
      `Model returned invalid JSON arguments for tool: ${toolName}`,
      false,
      { cause: error },
    );
  }
}

function readOutputText(response: ResponsesResponse): string {
  if (response.output_text?.trim()) {
    return response.output_text.trim();
  }
  return response.output
    .filter((item): item is ResponsesOutputMessage => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function limitInput(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  return `[Earlier context truncated]\n${value.slice(value.length - maximum)}`;
}

function readPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}
