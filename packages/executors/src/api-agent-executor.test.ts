import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ExecutorEvent, TaskRequest } from '@feishu-agent/contracts';

import {
  ApiAgentExecutor,
  type ResponsesClient,
  type ResponsesCreateRequest,
  type ResponsesResponse,
} from './api-agent-executor.js';
import { ToolGateway } from './tool-gateway.js';

const task: TaskRequest = {
  id: 'f5a7d7d4-2ca8-48ab-b65d-b9f85ed35d3f',
  source: {
    channel: 'feishu',
    eventId: 'event-api',
    chatId: 'chat-1',
    userId: 'user-1',
    replyTargetId: 'message-1',
  },
  input: { text: 'Summarize platform health', attachments: [] },
  riskLevel: 'low',
  correlationId: 'trace-api',
  createdAt: '2026-08-20T00:00:00.000Z',
  metadata: {},
};

class FakeResponsesClient implements ResponsesClient {
  public readonly requests: ResponsesCreateRequest[] = [];
  private index = 0;

  public constructor(private readonly responses: ResponsesResponse[]) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  public async create(request: ResponsesCreateRequest): Promise<ResponsesResponse> {
    this.requests.push(request);
    const response = this.responses[this.index++];
    if (!response) {
      throw new Error('Unexpected Responses API call.');
    }
    return response;
  }
}

describe('ApiAgentExecutor', () => {
  it('runs a bounded Responses tool loop with only task-approved tools', async () => {
    const tool = vi.fn(() => ({ status: 'ok' }));
    const gateway = new ToolGateway([
      {
        name: 'platform.health',
        description: 'Read platform health.',
        operation: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        schema: z.object({}).strict(),
        execute: tool,
      },
      {
        name: 'admin.secret',
        description: 'A tool that must not be exposed.',
        operation: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        schema: z.object({}).strict(),
        execute: () => 'secret',
      },
    ]);
    const client = new FakeResponsesClient([
      {
        id: 'resp-1',
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'platform_health',
            arguments: '{}',
          },
        ],
      },
      { id: 'resp-2', output: [], output_text: 'Platform health is ok.' },
    ]);
    const executor = new ApiAgentExecutor(client, gateway, { model: 'test-model', maxTurns: 3 });
    const events: ExecutorEvent[] = [];
    for await (const event of executor.execute(task, {
      signal: new AbortController().signal,
      runId: '1c7056b9-176b-4310-a143-9e1063749875',
      attempt: 1,
      approvedToolNames: new Set(['platform.health']),
      contextText: 'Recent conversation context',
    })) {
      events.push(event);
    }

    expect(tool).toHaveBeenCalledOnce();
    expect(client.requests[0]?.tools.map(({ name }) => name)).toEqual(['platform_health']);
    expect(client.requests[1]?.previous_response_id).toBe('resp-1');
    expect(events.map(({ kind }) => kind)).toEqual([
      'started',
      'progress',
      'tool_call',
      'tool_result',
      'progress',
      'completed',
    ]);
    expect(events.at(-1)?.payload.output).toBe('Platform health is ok.');
    expect(events.find(({ kind }) => kind === 'tool_call')?.payload.toolName).toBe(
      'platform.health',
    );
  });

  it('fails closed when internal tool names produce the same API alias', async () => {
    const gateway = new ToolGateway([
      {
        name: 'platform.health',
        description: 'Read platform health.',
        operation: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        schema: z.object({}).strict(),
        execute: () => ({ status: 'ok' }),
      },
      {
        name: 'platform_health',
        description: 'Read alternate platform health.',
        operation: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        schema: z.object({}).strict(),
        execute: () => ({ status: 'ok' }),
      },
    ]);
    const executor = new ApiAgentExecutor(new FakeResponsesClient([]), gateway, {
      model: 'test-model',
    });

    const collect = async (): Promise<void> => {
      for await (const event of executor.execute(task, {
        signal: new AbortController().signal,
        runId: '1c7056b9-176b-4310-a143-9e1063749875',
        attempt: 1,
        approvedToolNames: new Set(['platform.health', 'platform_health']),
      })) {
        // Consume the executor stream so the validation error is observed.
        void event;
      }
    };

    await expect(collect()).rejects.toMatchObject({ code: 'API_TOOL_NAME_COLLISION' });
  });
});
