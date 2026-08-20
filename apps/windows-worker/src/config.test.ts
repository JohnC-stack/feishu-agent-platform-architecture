import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readWindowsWorkerRuntimeConfig, resolveCodexLaunch } from './config.js';

describe('readWindowsWorkerRuntimeConfig', () => {
  it('does not require API credentials to start deterministic and CLI executors', () => {
    const config = readWindowsWorkerRuntimeConfig({
      AGENT_TASK_ROOT: 'D:\\runtime\\tasks',
      AGENT_AUTHORIZED_WORKSPACE_ROOTS: 'D:\\repos;D:\\work',
      CODEX_CLI_COMMAND: 'codex-test',
    });

    expect(config.apiConfigured).toBe(false);
    expect(config.apiAgentEnabled).toBe(false);
    expect(config.codex.command).toBe('codex-test');
    expect(config.authorizedWorkspaceRoots).toHaveLength(2);
  });

  it('requires the feature flag as well as a key to configure the API Agent', () => {
    const disabled = readWindowsWorkerRuntimeConfig({
      AGENT_TASK_ROOT: 'D:\\runtime\\tasks',
      AGENT_AUTHORIZED_WORKSPACE_ROOTS: 'D:\\repos',
      CODEX_CLI_COMMAND: 'codex-test',
      API_AGENT_ENABLED: 'false',
      OPENAI_API_KEY: 'test-key',
    });
    const enabled = readWindowsWorkerRuntimeConfig({
      AGENT_TASK_ROOT: 'D:\\runtime\\tasks',
      AGENT_AUTHORIZED_WORKSPACE_ROOTS: 'D:\\repos',
      CODEX_CLI_COMMAND: 'codex-test',
      API_AGENT_ENABLED: 'true',
      OPENAI_API_KEY: 'test-key',
    });

    expect(disabled).toMatchObject({ apiAgentEnabled: false, apiConfigured: false });
    expect(enabled).toMatchObject({ apiAgentEnabled: true, apiConfigured: true });
  });

  it.skipIf(process.platform !== 'win32')(
    'resolves the pnpm Codex entrypoint without requiring PNPM_HOME in the current process',
    () => {
      const localAppData = mkdtempSync(join(tmpdir(), 'codex-config-'));
      const bin = join(localAppData, 'pnpm', 'bin');
      const entrypoint = join(
        localAppData,
        'pnpm',
        'global',
        'v11',
        'test',
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js',
      );
      try {
        mkdirSync(bin, { recursive: true });
        mkdirSync(join(entrypoint, '..'), { recursive: true });
        writeFileSync(entrypoint, '');
        writeFileSync(
          join(bin, 'codex.cmd'),
          '@SETLOCAL\r\nnode "%~dp0\\..\\global\\v11\\test\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
        );

        expect(resolveCodexLaunch({ LOCALAPPDATA: localAppData })).toEqual({
          command: process.execPath,
          prefixArguments: [entrypoint],
        });
      } finally {
        rmSync(localAppData, { recursive: true, force: true });
      }
    },
  );
});
