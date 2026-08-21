import type { ExecutorErrorCategory, TaskRequest } from '@feishu-agent/contracts';
import {
  ConfluenceReadonlyClient,
  FeishuReadonlyClient,
  GitLabReadonlyClient,
  IntegrationError,
  PowerShellConfluenceRunner,
  type ConfluenceReadonlyClientOptions,
  type FeishuReadonlyClientOptions,
  type GitLabReadonlyClientOptions,
} from '@feishu-agent/integrations';
import {
  ExecutorRuntimeError,
  type ToolDefinition,
  type ToolExecutionContext,
} from '@feishu-agent/executors';
import { z } from 'zod';

const GitLabReadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('project'), project: z.string().min(1).max(500) }).strict(),
  z
    .object({
      action: z.literal('merge_request'),
      project: z.string().min(1).max(500),
      iid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal('diffs'),
      project: z.string().min(1).max(500),
      iid: z.number().int().positive(),
      page: z.number().int().positive().max(10_000).default(1),
      perPage: z.number().int().positive().max(100).default(20),
    })
    .strict(),
  z
    .object({
      action: z.literal('pipeline'),
      project: z.string().min(1).max(500),
      pipelineId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal('job_trace'),
      project: z.string().min(1).max(500),
      jobId: z.number().int().positive(),
    })
    .strict(),
]);

const ConfluenceReadSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('search'),
      spaceKey: z.string().min(1).max(255),
      text: z.string().min(1).max(500),
      limit: z.number().int().positive().max(50).default(10),
    })
    .strict(),
  z
    .object({
      action: z.enum(['page', 'attachments', 'comments']),
      spaceKey: z.string().min(1).max(255),
      pageId: z.string().min(1).max(255),
      limit: z.number().int().positive().max(50).default(25),
    })
    .strict(),
]);

const FeishuReadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('document'), documentId: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('bitable'), appToken: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('chat'), chatId: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('user'), userId: z.string().min(1).max(500) }).strict(),
]);

export interface EnterpriseIntegrationClients {
  gitlab?: GitLabReadonlyClient;
  confluence?: ConfluenceReadonlyClient;
  feishu?: FeishuReadonlyClient;
}

export interface EnterpriseIntegrationStatus {
  gitlab: boolean;
  confluence: boolean;
  feishu: boolean;
}

export interface EnterpriseIntegrationRuntime {
  tools: ToolDefinition[];
  status: EnterpriseIntegrationStatus;
}

export function createEnterpriseIntegrationRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  clients: EnterpriseIntegrationClients = createClients(environment),
): EnterpriseIntegrationRuntime {
  return {
    status: {
      gitlab: clients.gitlab !== undefined,
      confluence: clients.confluence !== undefined,
      feishu: clients.feishu !== undefined,
    },
    tools: [
      {
        name: 'gitlab.read',
        description:
          'Read an approved GitLab project, merge request, diff, pipeline, or job trace.',
        operation: 'read',
        parameters: gitLabParameters,
        schema: GitLabReadSchema,
        execute: (arguments_, context) =>
          executeGitLab(clients.gitlab, GitLabReadSchema.parse(arguments_), context),
      },
      {
        name: 'confluence.read',
        description:
          'Search or read approved Confluence spaces, pages, attachment metadata, and comments.',
        operation: 'read',
        parameters: confluenceParameters,
        schema: ConfluenceReadSchema,
        execute: (arguments_, context) =>
          executeConfluence(clients.confluence, ConfluenceReadSchema.parse(arguments_), context),
      },
      {
        name: 'feishu.read',
        description: 'Read approved Feishu documents, bitables, chats, and users.',
        operation: 'read',
        parameters: feishuParameters,
        schema: FeishuReadSchema,
        execute: (arguments_, context) =>
          executeFeishu(clients.feishu, FeishuReadSchema.parse(arguments_), context),
      },
    ],
  };
}

export function parseGitLabCommand(task: TaskRequest): unknown {
  const [, action, resource, identifier, page, perPage] = tokenize(task.input.text);
  switch (action?.toLowerCase()) {
    case 'project':
      return { action: 'project', project: resource };
    case 'mr':
      return { action: 'merge_request', project: resource, iid: Number(identifier) };
    case 'diffs':
      return {
        action: 'diffs',
        project: resource,
        iid: Number(identifier),
        ...(page ? { page: Number(page) } : {}),
        ...(perPage ? { perPage: Number(perPage) } : {}),
      };
    case 'pipeline':
      return { action: 'pipeline', project: resource, pipelineId: Number(identifier) };
    case 'job':
      return { action: 'job_trace', project: resource, jobId: Number(identifier) };
    default:
      return {};
  }
}

export function parseConfluenceCommand(task: TaskRequest): unknown {
  const [, action, spaceKey, pageIdOrText, limit] = tokenize(task.input.text);
  if (action?.toLowerCase() === 'search') {
    const tokens = tokenize(task.input.text);
    return {
      action: 'search',
      spaceKey,
      text: tokens.slice(3).join(' '),
    };
  }
  if (['page', 'attachments', 'comments'].includes(action?.toLowerCase() ?? '')) {
    return {
      action: action?.toLowerCase(),
      spaceKey,
      pageId: pageIdOrText,
      ...(limit ? { limit: Number(limit) } : {}),
    };
  }
  return {};
}

export function parseFeishuCommand(task: TaskRequest): unknown {
  const [, action, resource] = tokenize(task.input.text);
  switch (action?.toLowerCase()) {
    case 'document':
      return { action: 'document', documentId: resource };
    case 'bitable':
      return { action: 'bitable', appToken: resource };
    case 'chat':
      return { action: 'chat', chatId: resource };
    case 'user':
      return { action: 'user', userId: resource };
    default:
      return {};
  }
}

function createClients(environment: NodeJS.ProcessEnv): EnterpriseIntegrationClients {
  const common = readCommonConfig(environment);
  const clients: EnterpriseIntegrationClients = {};
  const gitlabProjects = readList(environment.GITLAB_ALLOWED_PROJECTS);
  if (environment.GITLAB_BASE_URL && environment.GITLAB_TOKEN && gitlabProjects.length > 0) {
    const options: GitLabReadonlyClientOptions = {
      baseUrl: environment.GITLAB_BASE_URL,
      token: environment.GITLAB_TOKEN,
      allowedProjects: gitlabProjects,
      ...common,
    };
    clients.gitlab = new GitLabReadonlyClient(options);
  }
  const confluenceSpaces = readList(environment.CONFLUENCE_ALLOWED_SPACE_KEYS);
  if (environment.CONFLUENCE_CLI_WRAPPER && confluenceSpaces.length > 0) {
    const options: ConfluenceReadonlyClientOptions = {
      runner: new PowerShellConfluenceRunner({
        wrapperPath: environment.CONFLUENCE_CLI_WRAPPER,
        maxOutputBytes: common.http?.maxResponseBytes,
        timeoutMs: common.http?.timeoutMs,
      }),
      allowedSpaceKeys: confluenceSpaces,
      allowedPageIds: readList(environment.CONFLUENCE_ALLOWED_PAGE_IDS),
      maxAttempts: common.http?.maxAttempts,
      retryBaseDelayMs: common.http?.retryBaseDelayMs,
      maxOutputCharacters: common.maxOutputCharacters,
    };
    clients.confluence = new ConfluenceReadonlyClient(options);
  }
  const feishuResources = [
    ...readList(environment.FEISHU_ALLOWED_DOCUMENT_IDS),
    ...readList(environment.FEISHU_ALLOWED_BITABLE_APP_TOKENS),
    ...readList(environment.FEISHU_ALLOWED_CHAT_IDS),
    ...readList(environment.FEISHU_ALLOWED_USER_IDS),
  ];
  if (environment.FEISHU_APP_ID && environment.FEISHU_APP_SECRET && feishuResources.length > 0) {
    const options: FeishuReadonlyClientOptions = {
      appId: environment.FEISHU_APP_ID,
      appSecret: environment.FEISHU_APP_SECRET,
      allowedDocumentIds: readList(environment.FEISHU_ALLOWED_DOCUMENT_IDS),
      allowedBitableAppTokens: readList(environment.FEISHU_ALLOWED_BITABLE_APP_TOKENS),
      allowedChatIds: readList(environment.FEISHU_ALLOWED_CHAT_IDS),
      allowedUserIds: readList(environment.FEISHU_ALLOWED_USER_IDS),
      ...(environment.FEISHU_OPENAPI_BASE_URL
        ? { baseUrl: environment.FEISHU_OPENAPI_BASE_URL }
        : {}),
      maxAttempts: common.http?.maxAttempts,
      retryBaseDelayMs: common.http?.retryBaseDelayMs,
      maxOutputCharacters: common.maxOutputCharacters,
      http: common.http,
    };
    clients.feishu = new FeishuReadonlyClient(options);
  }
  return clients;
}

function readCommonConfig(environment: NodeJS.ProcessEnv): {
  maxOutputCharacters: number;
  http: NonNullable<GitLabReadonlyClientOptions['http']>;
} {
  return {
    maxOutputCharacters: readInteger(
      environment.INTEGRATION_RESULT_MAX_CHARACTERS,
      20_000,
      100,
      1_000_000,
    ),
    http: {
      maxAttempts: readInteger(environment.INTEGRATION_MAX_ATTEMPTS, 3, 1, 10),
      timeoutMs: readInteger(environment.INTEGRATION_TIMEOUT_MS, 10_000, 50, 300_000),
      retryBaseDelayMs: readInteger(environment.INTEGRATION_RETRY_BASE_MS, 250, 0, 60_000),
      maxRetryDelayMs: readInteger(environment.INTEGRATION_MAX_RETRY_MS, 5_000, 0, 300_000),
      maxResponseBytes: readInteger(
        environment.INTEGRATION_MAX_RESPONSE_BYTES,
        1_000_000,
        1_024,
        100_000_000,
      ),
    },
  };
}

async function executeGitLab(
  client: GitLabReadonlyClient | undefined,
  arguments_: z.infer<typeof GitLabReadSchema>,
  context: ToolExecutionContext,
): Promise<unknown> {
  const integration = requireClient(client, 'GITLAB_INTEGRATION_NOT_CONFIGURED');
  return mapIntegrationError(async () => {
    switch (arguments_.action) {
      case 'project':
        return integration.getProject(arguments_.project, context.signal);
      case 'merge_request':
        return integration.getMergeRequest(arguments_.project, arguments_.iid, context.signal);
      case 'diffs':
        return integration.listMergeRequestDiffs(
          arguments_.project,
          arguments_.iid,
          context.signal,
          arguments_.page,
          arguments_.perPage,
        );
      case 'pipeline':
        return integration.getPipeline(arguments_.project, arguments_.pipelineId, context.signal);
      case 'job_trace':
        return integration.getJobTrace(arguments_.project, arguments_.jobId, context.signal);
    }
  });
}

async function executeConfluence(
  client: ConfluenceReadonlyClient | undefined,
  arguments_: z.infer<typeof ConfluenceReadSchema>,
  context: ToolExecutionContext,
): Promise<unknown> {
  const integration = requireClient(client, 'CONFLUENCE_INTEGRATION_NOT_CONFIGURED');
  return mapIntegrationError(async () => {
    switch (arguments_.action) {
      case 'search':
        return integration.searchPages(
          arguments_.spaceKey,
          arguments_.text,
          context.signal,
          arguments_.limit,
        );
      case 'page':
        return integration.getPage(arguments_.spaceKey, arguments_.pageId, context.signal);
      case 'attachments':
        return integration.listAttachments(
          arguments_.spaceKey,
          arguments_.pageId,
          context.signal,
          arguments_.limit,
        );
      case 'comments':
        return integration.listComments(
          arguments_.spaceKey,
          arguments_.pageId,
          context.signal,
          arguments_.limit,
        );
    }
  });
}

async function executeFeishu(
  client: FeishuReadonlyClient | undefined,
  arguments_: z.infer<typeof FeishuReadSchema>,
  context: ToolExecutionContext,
): Promise<unknown> {
  const integration = requireClient(client, 'FEISHU_INTEGRATION_NOT_CONFIGURED');
  return mapIntegrationError(async () => {
    switch (arguments_.action) {
      case 'document':
        return integration.getDocument(arguments_.documentId, context.signal);
      case 'bitable':
        return integration.getBitable(arguments_.appToken, context.signal);
      case 'chat':
        return integration.getChat(arguments_.chatId, context.signal);
      case 'user':
        return integration.getUser(arguments_.userId, context.signal);
    }
  });
}

function requireClient<T>(client: T | undefined, code: string): T {
  if (!client) {
    throw new ExecutorRuntimeError(
      'dependency',
      code,
      'Enterprise integration is not configured with credentials and an explicit resource allowlist.',
      false,
    );
  }
  return client;
}

async function mapIntegrationError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action();
  } catch (error: unknown) {
    if (!(error instanceof IntegrationError)) {
      throw error;
    }
    throw new ExecutorRuntimeError(
      mapCategory(error.category),
      error.code,
      error.message,
      error.retryable,
      {
        cause: error,
      },
    );
  }
}

function mapCategory(category: IntegrationError['category']): ExecutorErrorCategory {
  switch (category) {
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'validation':
      return 'validation';
    case 'unauthorized':
      return 'unauthorized';
    case 'rate_limited':
      return 'rate_limited';
    case 'dependency':
      return 'dependency';
    case 'not_found':
    case 'remote':
    case 'malformed_response':
      return 'tool';
  }
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of value.matchAll(pattern)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"'])/g, '$1'));
  }
  return tokens;
}

function readList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}; received ${value}.`);
  }
  return parsed;
}

const gitLabParameters = {
  type: 'object',
  oneOf: [
    requiredProperties('project', ['project']),
    requiredProperties('merge_request', ['project', 'iid']),
    requiredProperties('diffs', ['project', 'iid']),
    requiredProperties('pipeline', ['project', 'pipelineId']),
    requiredProperties('job_trace', ['project', 'jobId']),
  ],
};

const confluenceParameters = {
  type: 'object',
  oneOf: [
    requiredProperties('search', ['spaceKey', 'text']),
    requiredProperties('page', ['spaceKey', 'pageId']),
    requiredProperties('attachments', ['spaceKey', 'pageId']),
    requiredProperties('comments', ['spaceKey', 'pageId']),
  ],
};

const feishuParameters = {
  type: 'object',
  oneOf: [
    requiredProperties('document', ['documentId']),
    requiredProperties('bitable', ['appToken']),
    requiredProperties('chat', ['chatId']),
    requiredProperties('user', ['userId']),
  ],
};

function requiredProperties(action: string, required: readonly string[]) {
  return {
    type: 'object',
    properties: { action: { const: action } },
    required: ['action', ...required],
    additionalProperties: true,
  };
}
