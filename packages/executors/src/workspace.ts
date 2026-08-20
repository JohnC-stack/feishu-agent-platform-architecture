import { execFile } from 'node:child_process';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { ExecutorRuntimeError } from './errors.js';

const execFileAsync = promisify(execFile);

export interface WorkspaceBinding {
  taskId: string;
  taskDirectory: string;
  workspacePath: string;
}

export interface WorkspaceAclController {
  restrictToCurrentUser(directory: string): Promise<void>;
}

export class NoopWorkspaceAclController implements WorkspaceAclController {
  // A portable test/development implementation; production Windows uses WindowsWorkspaceAclController.
  public restrictToCurrentUser(directory: string): Promise<void> {
    void directory;
    return Promise.resolve();
  }
}

export class WindowsWorkspaceAclController implements WorkspaceAclController {
  public async restrictToCurrentUser(directory: string): Promise<void> {
    if (process.platform !== 'win32') {
      throw new ExecutorRuntimeError(
        'sandbox',
        'WINDOWS_ACL_UNAVAILABLE',
        'Windows ACL enforcement is only available on Windows.',
        false,
      );
    }
    const identity = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME ?? ''}`
      : (process.env.USERNAME ?? '');
    if (!identity || identity.endsWith('\\')) {
      throw new ExecutorRuntimeError(
        'sandbox',
        'WINDOWS_IDENTITY_UNAVAILABLE',
        'Current Windows identity is unavailable for ACL enforcement.',
        false,
      );
    }
    try {
      await execFileAsync(
        'icacls.exe',
        [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`],
        {
          windowsHide: true,
        },
      );
    } catch (error: unknown) {
      throw new ExecutorRuntimeError(
        'sandbox',
        'WINDOWS_ACL_FAILED',
        'Failed to apply the task-directory ACL.',
        false,
        { cause: error },
      );
    }
  }
}

export interface TaskWorkspaceManagerOptions {
  taskRoot: string;
  authorizedWorkspaceRoots: readonly string[];
  aclController?: WorkspaceAclController;
}

export class TaskWorkspaceManager {
  private readonly taskRoot: string;
  private readonly authorizedRoots: string[];
  private readonly aclController: WorkspaceAclController;

  public constructor(options: TaskWorkspaceManagerOptions) {
    if (!isAbsolute(options.taskRoot)) {
      throw new Error('Task workspace root must be an absolute path.');
    }
    if (options.authorizedWorkspaceRoots.length === 0) {
      throw new Error('At least one authorized workspace root is required.');
    }
    this.taskRoot = resolve(options.taskRoot);
    this.authorizedRoots = options.authorizedWorkspaceRoots.map((root) => {
      if (!isAbsolute(root)) {
        throw new Error(`Authorized workspace root must be absolute: ${root}`);
      }
      return resolve(root);
    });
    this.aclController = options.aclController ?? new NoopWorkspaceAclController();
  }

  public async prepare(taskId: string, requestedWorkspacePath: string): Promise<WorkspaceBinding> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
      throw new ExecutorRuntimeError(
        'validation',
        'TASK_ID_INVALID',
        'Task workspace requires a UUID task identifier.',
        false,
      );
    }
    const workspacePath = await realpath(resolve(requestedWorkspacePath));
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      throw new ExecutorRuntimeError(
        'sandbox',
        'WORKSPACE_NOT_DIRECTORY',
        'Authorized workspace path is not a directory.',
        false,
      );
    }
    if (!this.authorizedRoots.some((root) => isWithin(root, workspacePath))) {
      throw new ExecutorRuntimeError(
        'unauthorized',
        'WORKSPACE_NOT_AUTHORIZED',
        'Requested workspace is outside the authorized roots.',
        false,
      );
    }
    await mkdir(this.taskRoot, { recursive: true });
    const taskDirectory = resolve(this.taskRoot, taskId);
    if (!isWithin(this.taskRoot, taskDirectory) || taskDirectory === this.taskRoot) {
      throw new ExecutorRuntimeError(
        'sandbox',
        'TASK_DIRECTORY_ESCAPE',
        'Task directory escaped the configured task root.',
        false,
      );
    }
    await mkdir(taskDirectory, { recursive: false }).catch(async (error: unknown) => {
      const existing = await stat(taskDirectory).catch(() => undefined);
      if (!existing?.isDirectory()) {
        throw error;
      }
    });
    await this.aclController.restrictToCurrentUser(taskDirectory);
    return { taskId, taskDirectory, workspacePath };
  }

  public async cleanup(binding: WorkspaceBinding): Promise<void> {
    const target = resolve(binding.taskDirectory);
    if (!isWithin(this.taskRoot, target) || target === this.taskRoot) {
      throw new ExecutorRuntimeError(
        'sandbox',
        'TASK_CLEANUP_ESCAPE',
        'Refused to clean a directory outside the configured task root.',
        false,
      );
    }
    await rm(target, { recursive: true, force: true });
  }
}

export interface ExecutorResourceLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxEvents: number;
}

export function validateResourceLimits(limits: ExecutorResourceLimits): ExecutorResourceLimits {
  if (
    !Number.isInteger(limits.timeoutMs) ||
    limits.timeoutMs < 100 ||
    limits.timeoutMs > 86_400_000
  ) {
    throw new Error('Executor timeout must be an integer between 100 and 86400000 milliseconds.');
  }
  if (!Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1_024) {
    throw new Error('Executor output limit must be at least 1024 bytes.');
  }
  if (!Number.isInteger(limits.maxEvents) || limits.maxEvents < 2) {
    throw new Error('Executor event limit must be at least 2.');
  }
  return { ...limits };
}

export interface SandboxLease {
  kind: 'local_workspace' | 'hyperv';
  workspacePath: string;
  dispose(): Promise<void>;
}

export interface SandboxProvider {
  prepare(binding: WorkspaceBinding): Promise<SandboxLease>;
}

export class LocalWorkspaceSandboxProvider implements SandboxProvider {
  // The Codex CLI still receives its own workspace-write sandbox flag; this lease records the host boundary.
  public prepare(binding: WorkspaceBinding): Promise<SandboxLease> {
    return Promise.resolve({
      kind: 'local_workspace',
      workspacePath: binding.workspacePath,
      dispose: () => Promise.resolve(),
    });
  }
}

export class UnavailableHyperVSandboxProvider implements SandboxProvider {
  public prepare(binding: WorkspaceBinding): Promise<SandboxLease> {
    void binding;
    return Promise.reject(
      new ExecutorRuntimeError(
        'sandbox',
        'HYPERV_SANDBOX_UNAVAILABLE',
        'Hyper-V sandbox provider is not configured on this worker.',
        false,
      ),
    );
  }
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  );
}
