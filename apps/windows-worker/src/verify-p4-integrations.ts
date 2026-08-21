import { randomUUID } from 'node:crypto';

import type { TaskRequest } from '@feishu-agent/contracts';
import { ToolGateway } from '@feishu-agent/executors';

import { verifyGitLabTokenPolicy } from './gitlab-token-policy.js';
import { createEnterpriseIntegrationRuntime } from './integration-tools.js';

interface VerificationCheck {
  system: 'gitlab' | 'confluence' | 'feishu';
  operation: string;
  ok: boolean;
  code?: string;
  truncated?: boolean;
}

async function main(): Promise<void> {
  const runtime = createEnterpriseIntegrationRuntime();
  const gateway = new ToolGateway(runtime.tools);
  const requested = new Set(
    readList(process.env.INTEGRATION_VERIFY_TARGETS ?? 'gitlab,confluence,feishu'),
  );
  const checks: VerificationCheck[] = [];

  if (requested.has('gitlab')) {
    const projects = readList(process.env.GITLAB_ALLOWED_PROJECTS);
    if (!runtime.status.gitlab || projects.length === 0) {
      checks.push(configurationMissing('gitlab'));
    } else {
      const tokenPolicy = await verifyGitLabTokenPolicy({
        baseUrl: process.env.GITLAB_BASE_URL ?? '',
        token: process.env.GITLAB_TOKEN ?? '',
        signal: AbortSignal.timeout(
          readPositiveInteger(process.env.INTEGRATION_TIMEOUT_MS, 10_000),
        ),
      });
      checks.push({ system: 'gitlab', operation: 'token_policy', ...tokenPolicy });
      if (tokenPolicy.ok) {
        for (const project of projects) {
          checks.push(await invoke(gateway, 'gitlab', 'project', { action: 'project', project }));
        }
        const verifyProject = process.env.GITLAB_VERIFY_PROJECT?.trim();
        const mergeRequestIid = readOptionalPositiveInteger(
          process.env.GITLAB_VERIFY_MERGE_REQUEST_IID,
        );
        const pipelineId = readOptionalPositiveInteger(process.env.GITLAB_VERIFY_PIPELINE_ID);
        const jobId = readOptionalPositiveInteger(process.env.GITLAB_VERIFY_JOB_ID);
        if (verifyProject && mergeRequestIid) {
          checks.push(
            await invoke(gateway, 'gitlab', 'merge_request', {
              action: 'merge_request',
              project: verifyProject,
              iid: mergeRequestIid,
            }),
          );
          checks.push(
            await invoke(gateway, 'gitlab', 'diffs', {
              action: 'diffs',
              project: verifyProject,
              iid: mergeRequestIid,
              page: 1,
              perPage: 20,
            }),
          );
        }
        if (verifyProject && pipelineId) {
          checks.push(
            await invoke(gateway, 'gitlab', 'pipeline', {
              action: 'pipeline',
              project: verifyProject,
              pipelineId,
            }),
          );
        }
        if (verifyProject && jobId) {
          checks.push(
            await invoke(gateway, 'gitlab', 'job_trace', {
              action: 'job_trace',
              project: verifyProject,
              jobId,
            }),
          );
        }
      }
    }
  }

  if (requested.has('confluence')) {
    const spaceKey = readList(process.env.CONFLUENCE_ALLOWED_SPACE_KEYS)[0];
    const pageId = readList(process.env.CONFLUENCE_ALLOWED_PAGE_IDS)[0];
    if (!runtime.status.confluence || !spaceKey) {
      checks.push(configurationMissing('confluence'));
    } else if (pageId) {
      checks.push(
        await invoke(gateway, 'confluence', 'page', { action: 'page', spaceKey, pageId }),
      );
      checks.push(
        await invoke(gateway, 'confluence', 'attachments', {
          action: 'attachments',
          spaceKey,
          pageId,
        }),
      );
      checks.push(
        await invoke(gateway, 'confluence', 'comments', {
          action: 'comments',
          spaceKey,
          pageId,
        }),
      );
    } else {
      checks.push(
        await invoke(gateway, 'confluence', 'search', {
          action: 'search',
          spaceKey,
          text: process.env.CONFLUENCE_VERIFY_SEARCH_TEXT ?? 'test',
        }),
      );
    }
  }

  if (requested.has('feishu')) {
    if (!runtime.status.feishu) {
      checks.push(configurationMissing('feishu'));
    } else {
      const resources = [
        ['document', 'documentId', readList(process.env.FEISHU_ALLOWED_DOCUMENT_IDS)],
        ['bitable', 'appToken', readList(process.env.FEISHU_ALLOWED_BITABLE_APP_TOKENS)],
        ['chat', 'chatId', readList(process.env.FEISHU_ALLOWED_CHAT_IDS)],
        ['user', 'userId', readList(process.env.FEISHU_ALLOWED_USER_IDS)],
      ] as const;
      for (const [operation, field, values] of resources) {
        for (const value of values) {
          checks.push(
            await invoke(gateway, 'feishu', operation, { action: operation, [field]: value }),
          );
        }
      }
      if (!resources.some(([, , values]) => values.length > 0)) {
        checks.push(configurationMissing('feishu'));
      }
    }
  }

  const result = {
    ok: checks.length > 0 && checks.every((check) => check.ok),
    configured: runtime.status,
    checks,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function invoke(
  gateway: ToolGateway,
  system: VerificationCheck['system'],
  operation: string,
  arguments_: Record<string, unknown>,
): Promise<VerificationCheck> {
  const toolName = `${system}.read`;
  const task = createTask(`/${system} ${operation}`);
  try {
    const result = await gateway.invoke(toolName, arguments_, new Set([toolName]), {
      task,
      signal: new AbortController().signal,
    });
    return { system, operation, ok: true, truncated: result.truncated };
  } catch (error: unknown) {
    return {
      system,
      operation,
      ok: false,
      code: readErrorCode(error),
    };
  }
}

function createTask(text: string): TaskRequest {
  return {
    id: randomUUID(),
    source: {
      channel: 'feishu',
      eventId: randomUUID(),
      chatId: 'p4-verification',
      userId: 'p4-verification',
      replyTargetId: 'p4-verification',
    },
    input: { text, attachments: [] },
    riskLevel: 'low',
    correlationId: randomUUID(),
    createdAt: new Date().toISOString(),
    metadata: { verification: 'P4' },
  };
}

function configurationMissing(system: VerificationCheck['system']): VerificationCheck {
  return { system, operation: 'configuration', ok: false, code: 'CONFIGURATION_MISSING' };
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'UNKNOWN_ERROR';
}

function readList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

void main();
