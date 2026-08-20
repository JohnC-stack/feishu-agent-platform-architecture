import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskWorkspaceManager, type WorkspaceAclController } from './workspace.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('TaskWorkspaceManager', () => {
  it('binds only an authorized workspace, applies ACLs, and safely cleans task data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-workspace-'));
    temporaryDirectories.push(root);
    const authorized = join(root, 'authorized');
    const taskRoot = join(root, 'tasks');
    await mkdir(authorized);
    const restrictToCurrentUser = vi.fn<WorkspaceAclController['restrictToCurrentUser']>();
    const manager = new TaskWorkspaceManager({
      taskRoot,
      authorizedWorkspaceRoots: [authorized],
      aclController: { restrictToCurrentUser },
    });
    const binding = await manager.prepare('17fd270d-63e4-49b0-8289-646e0c631375', authorized);

    expect(binding.workspacePath).toBe(await realpath(authorized));
    expect(restrictToCurrentUser).toHaveBeenCalledWith(binding.taskDirectory);
    await manager.cleanup(binding);
    await expect(realpath(binding.taskDirectory)).rejects.toThrow();
  });

  it('rejects a workspace outside the authorization roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-workspace-'));
    temporaryDirectories.push(root);
    const authorized = join(root, 'authorized');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(authorized), mkdir(outside)]);
    const manager = new TaskWorkspaceManager({
      taskRoot: join(root, 'tasks'),
      authorizedWorkspaceRoots: [authorized],
    });

    await expect(
      manager.prepare('17fd270d-63e4-49b0-8289-646e0c631375', outside),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_AUTHORIZED' });
  });
});
