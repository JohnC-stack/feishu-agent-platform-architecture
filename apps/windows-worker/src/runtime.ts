import { existsSync } from 'node:fs';
import { z } from 'zod';

import type { ExecutorEvent, ExecutorKind, TaskRequest } from '@feishu-agent/contracts';
import {
  AgentCliExecutor,
  ApiAgentExecutor,
  DirectToolExecutor,
  ExecutorRuntime,
  ExecutorRuntimeError,
  OpenAIResponsesClient,
  TaskWorkspaceManager,
  ToolGateway,
  WindowsWorkspaceAclController,
  type Executor,
  type ExecutorContext,
} from '@feishu-agent/executors';

import { readWindowsWorkerRuntimeConfig } from './config.js';
import { WindowsExecutionService } from './execution-service.js';
import {
  createEnterpriseIntegrationRuntime,
  parseConfluenceCommand,
  parseFeishuCommand,
  parseGitLabCommand,
  type EnterpriseIntegrationStatus,
} from './integration-tools.js';

export interface WindowsWorkerRuntime {
  executionService: WindowsExecutionService;
  status: {
    apiAgentEnabled: boolean;
    apiAgentConfigured: boolean;
    codexCliAvailable: boolean;
    hypervConfigured: boolean;
    integrations: EnterpriseIntegrationStatus;
  };
}

export function createWindowsWorkerRuntime(): WindowsWorkerRuntime {
  const config = readWindowsWorkerRuntimeConfig();
  const integrations = createEnterpriseIntegrationRuntime();
  const gateway = new ToolGateway([
    {
      name: 'platform.ping',
      description: 'Return a deterministic pong response.',
      operation: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      schema: z.object({}).strict(),
      execute: () => ({ reply: 'pong' }),
    },
    {
      name: 'platform.health',
      description: 'Return the Windows Worker process health.',
      operation: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      schema: z.object({}).strict(),
      execute: () => ({ status: 'ok', service: 'windows-worker' }),
    },
    ...integrations.tools,
  ]);
  const directExecutor = new DirectToolExecutor(gateway, [
    { command: '/ping', toolName: 'platform.ping' },
    { command: '/health', toolName: 'platform.health' },
    { command: '/gitlab', toolName: 'gitlab.read', parseArguments: parseGitLabCommand },
    {
      command: '/confluence',
      toolName: 'confluence.read',
      parseArguments: parseConfluenceCommand,
    },
    { command: '/feishu', toolName: 'feishu.read', parseArguments: parseFeishuCommand },
  ]);
  const apiExecutor: Executor = !config.apiAgentEnabled
    ? new UnavailableExecutor(
        'api_agent',
        'API_AGENT_DISABLED',
        'API Agent is disabled by configuration.',
        false,
      )
    : process.env.OPENAI_API_KEY
      ? new ApiAgentExecutor(
          new OpenAIResponsesClient(process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL),
          gateway,
          { model: config.apiModel },
        )
      : new UnavailableExecutor(
          'api_agent',
          'OPENAI_API_KEY_MISSING',
          'OPENAI_API_KEY is not configured on the Windows Worker.',
        );
  const agentExecutor = new AgentCliExecutor({
    command: config.codex.command,
    prefixArguments: config.codex.prefixArguments,
    ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
    sandbox: 'workspace-write',
    maxOutputBytes: config.executorMaxOutputBytes,
  });
  const runtime = new ExecutorRuntime({
    executors: [directExecutor, apiExecutor, agentExecutor],
    fallbackOrder: { api_agent: ['agent_cli'] },
    limits: {
      timeoutMs: config.executorTimeoutMs,
      maxOutputBytes: config.executorMaxOutputBytes,
      maxEvents: config.executorMaxEvents,
    },
  });
  const workspaceManager = new TaskWorkspaceManager({
    taskRoot: config.taskRoot,
    authorizedWorkspaceRoots: config.authorizedWorkspaceRoots,
    aclController: process.platform === 'win32' ? new WindowsWorkspaceAclController() : undefined,
  });
  return {
    executionService: new WindowsExecutionService({ runtime, workspaceManager }),
    status: {
      apiAgentEnabled: config.apiAgentEnabled,
      apiAgentConfigured: config.apiConfigured,
      codexCliAvailable:
        config.codex.command === process.execPath
          ? Boolean(config.codex.prefixArguments[0] && existsSync(config.codex.prefixArguments[0]))
          : true,
      hypervConfigured: false,
      integrations: integrations.status,
    },
  };
}

class UnavailableExecutor implements Executor {
  public constructor(
    public readonly kind: ExecutorKind,
    private readonly code: string,
    private readonly reason: string,
    private readonly retryable = true,
  ) {}

  public execute(task: TaskRequest, context: ExecutorContext): AsyncIterable<ExecutorEvent> {
    void task;
    void context;
    throw new ExecutorRuntimeError('dependency', this.code, this.reason, this.retryable);
  }
}
