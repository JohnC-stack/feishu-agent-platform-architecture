import { spawn } from 'node:child_process';

import { ExactResourceAllowlist } from './access-control.js';
import { IntegrationError, throwIfIntegrationAborted } from './errors.js';
import { boundIntegrationResult, redactText } from './redaction.js';
import type { BoundedIntegrationResult } from './types.js';

export interface ConfluenceCommandRunner {
  run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown>;
}

export interface PowerShellConfluenceRunnerOptions {
  wrapperPath: string;
  powershellCommand?: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export class PowerShellConfluenceRunner implements ConfluenceCommandRunner {
  private readonly command: string;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;

  public constructor(private readonly options: PowerShellConfluenceRunnerOptions) {
    if (!options.wrapperPath.trim()) {
      throw new Error('Confluence wrapper path is required.');
    }
    this.command = options.powershellCommand ?? 'powershell.exe';
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown> {
    throwIfIntegrationAborted(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.command,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.options.wrapperPath,
          ...arguments_,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let exceeded = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      const collect =
        (target: Buffer[]) =>
        (chunk: Buffer): void => {
          size += chunk.byteLength;
          if (size > this.maxOutputBytes) {
            exceeded = true;
            child.kill();
            return;
          }
          target.push(chunk);
        };
      child.stdout.on('data', collect(output));
      child.stderr.on('data', collect(errors));
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(
          signal.aborted
            ? new IntegrationError(
                'cancelled',
                'INTEGRATION_CANCELLED',
                'Confluence request was cancelled.',
                false,
              )
            : new IntegrationError(
                'dependency',
                'CONFLUENCE_CLI_START_FAILED',
                'Confluence CLI could not be started.',
                true,
                undefined,
                { cause: error },
              ),
        );
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(
            new IntegrationError(
              'timeout',
              'CONFLUENCE_CLI_TIMEOUT',
              `Confluence CLI exceeded ${this.timeoutMs} ms.`,
              true,
            ),
          );
          return;
        }
        if (exceeded) {
          reject(
            new IntegrationError(
              'remote',
              'CONFLUENCE_RESPONSE_TOO_LARGE',
              `Confluence response exceeded ${this.maxOutputBytes} bytes.`,
              false,
            ),
          );
          return;
        }
        const stdout = Buffer.concat(output).toString('utf8').trim();
        const stderr = redactText(Buffer.concat(errors).toString('utf8').trim()).slice(0, 2_000);
        if (code !== 0) {
          reject(classifyCliError(code, stderr));
          return;
        }
        try {
          resolve(stdout ? (JSON.parse(stdout) as unknown) : null);
        } catch (error: unknown) {
          reject(
            new IntegrationError(
              'malformed_response',
              'CONFLUENCE_RESPONSE_MALFORMED',
              'Confluence CLI returned malformed JSON.',
              true,
              undefined,
              { cause: error },
            ),
          );
        }
      });
    });
  }
}

export interface ConfluenceReadonlyClientOptions {
  runner: ConfluenceCommandRunner;
  allowedSpaceKeys: readonly string[];
  allowedPageIds: readonly string[];
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  maxOutputCharacters?: number;
}

export class ConfluenceReadonlyClient {
  private readonly spaces: ExactResourceAllowlist;
  private readonly pages: ExactResourceAllowlist;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxOutputCharacters: number;

  public constructor(private readonly options: ConfluenceReadonlyClientOptions) {
    this.spaces = new ExactResourceAllowlist(options.allowedSpaceKeys, 'Confluence space');
    this.pages = new ExactResourceAllowlist(options.allowedPageIds, 'Confluence page');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.maxOutputCharacters = options.maxOutputCharacters ?? 20_000;
  }

  public async searchPages(
    spaceKey: string,
    text: string,
    signal: AbortSignal,
    limit = 10,
  ): Promise<BoundedIntegrationResult> {
    const space = this.spaces.assertAllowed(spaceKey);
    const query = text.trim();
    if (!query || query.length > 500) {
      throw new IntegrationError(
        'validation',
        'CONFLUENCE_QUERY_INVALID',
        'Confluence search text must contain 1 to 500 characters.',
        false,
      );
    }
    const boundedLimit = boundedInteger(limit, 1, 50, 'limit');
    const cql = `space='${escapeCql(space)}' AND type=page AND text~'${escapeCql(query)}' order by lastmodified desc`;
    return this.bound(await this.run(['search', cql, '--limit', String(boundedLimit)], signal));
  }

  public async getPage(
    spaceKey: string,
    pageId: string,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const expectedSpace = this.spaces.assertAllowed(spaceKey);
    const page = this.pages.assertAllowed(pageId);
    const result = await this.run(
      ['page', 'get', page, '--expand', 'body.storage,version,space,ancestors'],
      signal,
    );
    assertReturnedSpace(result, expectedSpace);
    return this.bound(result);
  }

  public async listAttachments(
    spaceKey: string,
    pageId: string,
    signal: AbortSignal,
    limit = 25,
  ): Promise<BoundedIntegrationResult> {
    return this.readPageChildren(spaceKey, pageId, 'attachment', signal, limit);
  }

  public async listComments(
    spaceKey: string,
    pageId: string,
    signal: AbortSignal,
    limit = 25,
  ): Promise<BoundedIntegrationResult> {
    return this.readPageChildren(spaceKey, pageId, 'comment', signal, limit);
  }

  private async readPageChildren(
    spaceKey: string,
    pageId: string,
    childType: 'attachment' | 'comment',
    signal: AbortSignal,
    limit: number,
  ): Promise<BoundedIntegrationResult> {
    const expectedSpace = this.spaces.assertAllowed(spaceKey);
    const page = this.pages.assertAllowed(pageId);
    const boundedLimit = boundedInteger(limit, 1, 50, 'limit');
    const pageResult = await this.run(['page', 'get', page, '--expand', 'space'], signal);
    assertReturnedSpace(pageResult, expectedSpace);
    const result = await this.run(
      [
        'api',
        'GET',
        `content/${encodeURIComponent(page)}/child/${childType}`,
        '-q',
        `limit=${boundedLimit}`,
      ],
      signal,
    );
    return this.bound(result);
  }

  private async run(arguments_: readonly string[], signal: AbortSignal): Promise<unknown> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.options.runner.run(arguments_, signal);
      } catch (error: unknown) {
        if (
          !(error instanceof IntegrationError) ||
          !error.retryable ||
          attempt >= this.maxAttempts
        ) {
          throw error;
        }
        await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
    throw new IntegrationError(
      'dependency',
      'CONFLUENCE_RETRY_EXHAUSTED',
      'Confluence request exhausted its retry budget.',
      true,
    );
  }

  private bound(value: unknown): BoundedIntegrationResult {
    return boundIntegrationResult(value, this.maxOutputCharacters);
  }
}

function classifyCliError(code: number | null, stderr: string): IntegrationError {
  const detail = stderr ? ` ${stderr}` : '';
  if (/401|403|unauthori[sz]ed|forbidden|permission/i.test(stderr)) {
    return new IntegrationError(
      'unauthorized',
      'CONFLUENCE_ACCESS_DENIED',
      `Confluence denied the read request.${detail}`,
      false,
    );
  }
  if (/429|rate.?limit|too many requests/i.test(stderr)) {
    return new IntegrationError(
      'rate_limited',
      'CONFLUENCE_RATE_LIMITED',
      `Confluence rate limit was reached.${detail}`,
      true,
    );
  }
  return new IntegrationError(
    'dependency',
    'CONFLUENCE_CLI_FAILED',
    `Confluence CLI exited with code ${code ?? 'unknown'}.${detail}`,
    true,
  );
}

function assertReturnedSpace(value: unknown, expectedSpace: string): void {
  const spaceKey = readNestedString(value, ['space', 'key']);
  if (!spaceKey || spaceKey.toLowerCase() !== expectedSpace.toLowerCase()) {
    throw new IntegrationError(
      'unauthorized',
      'CONFLUENCE_SPACE_MISMATCH',
      'Confluence page did not belong to the approved space.',
      false,
    );
  }
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function escapeCql(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new IntegrationError(
      'validation',
      'CONFLUENCE_PARAMETER_INVALID',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
      false,
    );
  }
  return value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfIntegrationAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(
        new IntegrationError(
          'cancelled',
          'INTEGRATION_CANCELLED',
          'Confluence request was cancelled.',
          false,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
