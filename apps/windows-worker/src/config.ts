import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

export interface CodexLaunchConfig {
  command: string;
  prefixArguments: string[];
}

export interface WindowsWorkerRuntimeConfig {
  taskRoot: string;
  authorizedWorkspaceRoots: string[];
  codex: CodexLaunchConfig;
  apiAgentEnabled: boolean;
  apiModel: string;
  apiConfigured: boolean;
  executorTimeoutMs: number;
  executorMaxOutputBytes: number;
  executorMaxEvents: number;
}

export function readWindowsWorkerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WindowsWorkerRuntimeConfig {
  const taskRoot = resolve(
    environment.AGENT_TASK_ROOT ??
      resolve(environment.LOCALAPPDATA ?? process.cwd(), 'FeishuAgentPlatform', 'tasks'),
  );
  const authorizedWorkspaceRoots = (environment.AGENT_AUTHORIZED_WORKSPACE_ROOTS ?? process.cwd())
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => resolve(part));
  if (authorizedWorkspaceRoots.length === 0) {
    throw new Error('AGENT_AUTHORIZED_WORKSPACE_ROOTS must contain at least one path.');
  }
  const apiAgentEnabled = readBoolean(environment.API_AGENT_ENABLED, false, 'API_AGENT_ENABLED');
  return {
    taskRoot,
    authorizedWorkspaceRoots,
    codex: resolveCodexLaunch(environment),
    apiAgentEnabled,
    apiModel: environment.OPENAI_MODEL ?? 'gpt-5.4',
    apiConfigured: apiAgentEnabled && Boolean(environment.OPENAI_API_KEY),
    executorTimeoutMs: readInteger(environment.EXECUTOR_TIMEOUT_MS, 300_000, 100, 86_400_000),
    executorMaxOutputBytes: readInteger(
      environment.EXECUTOR_MAX_OUTPUT_BYTES,
      2_000_000,
      1_024,
      100_000_000,
    ),
    executorMaxEvents: readInteger(environment.EXECUTOR_MAX_EVENTS, 1_000, 2, 100_000),
  };
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

export function resolveCodexLaunch(
  environment: NodeJS.ProcessEnv = process.env,
): CodexLaunchConfig {
  if (environment.CODEX_CLI_ENTRYPOINT) {
    const entrypoint = resolve(environment.CODEX_CLI_ENTRYPOINT);
    if (!existsSync(entrypoint)) {
      throw new Error('CODEX_CLI_ENTRYPOINT does not exist.');
    }
    return { command: process.execPath, prefixArguments: [entrypoint] };
  }
  if (environment.CODEX_CLI_COMMAND) {
    return { command: environment.CODEX_CLI_COMMAND, prefixArguments: [] };
  }
  if (process.platform === 'win32') {
    for (const shim of findPnpmCodexShims(environment)) {
      const entrypoint = readPnpmCodexEntrypoint(shim);
      if (entrypoint) {
        return { command: process.execPath, prefixArguments: [entrypoint] };
      }
    }
  }
  return { command: 'codex', prefixArguments: [] };
}

function findPnpmCodexShims(environment: NodeJS.ProcessEnv): string[] {
  const candidates = new Set<string>();
  if (environment.PNPM_HOME) {
    candidates.add(resolve(environment.PNPM_HOME, 'bin', 'codex.cmd'));
    candidates.add(resolve(environment.PNPM_HOME, 'codex.cmd'));
  }
  if (environment.LOCALAPPDATA) {
    candidates.add(resolve(environment.LOCALAPPDATA, 'pnpm', 'bin', 'codex.cmd'));
    candidates.add(resolve(environment.LOCALAPPDATA, 'pnpm', 'codex.cmd'));
  }
  const searchPath = environment.Path ?? environment.PATH ?? environment.path ?? '';
  for (const part of searchPath.split(delimiter)) {
    const directory = part.trim().replace(/^"|"$/g, '');
    if (directory && !directory.includes('%')) {
      candidates.add(resolve(directory, 'codex.cmd'));
    }
  }
  return [...candidates];
}

function readPnpmCodexEntrypoint(shim: string): string | undefined {
  if (!existsSync(shim)) {
    return undefined;
  }
  const content = readFileSync(shim, 'utf8');
  const match = content.match(/"(%~dp0\\[^"\r\n]*node_modules\\@openai\\codex\\bin\\codex\.js)"/i);
  const raw = match?.[1];
  if (!raw) {
    return undefined;
  }
  const replaced = raw.replace(/^%~dp0\\?/i, `${dirname(shim)}\\`);
  const entrypoint = resolve(replaced);
  return isAbsolute(entrypoint) && existsSync(entrypoint) ? entrypoint : undefined;
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
