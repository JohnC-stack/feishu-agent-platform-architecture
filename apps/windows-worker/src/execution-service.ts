import {
  ExecutorExecutionResultSchema,
  type ExecutorExecutionRequest,
  type ExecutorExecutionResult,
  type ExecutorFailure,
} from '@feishu-agent/contracts';
import {
  ExecutorRuntimeError,
  LocalWorkspaceSandboxProvider,
  UnavailableHyperVSandboxProvider,
  classifyExecutorError,
  type ExecutorRuntime,
  type SandboxProvider,
  type TaskWorkspaceManager,
} from '@feishu-agent/executors';

export interface ExecutionServiceOptions {
  runtime: ExecutorRuntime;
  workspaceManager: TaskWorkspaceManager;
  localSandbox?: SandboxProvider;
  hypervSandbox?: SandboxProvider;
}

export class WindowsExecutionService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly localSandbox: SandboxProvider;
  private readonly hypervSandbox: SandboxProvider;

  public constructor(private readonly options: ExecutionServiceOptions) {
    this.localSandbox = options.localSandbox ?? new LocalWorkspaceSandboxProvider();
    this.hypervSandbox = options.hypervSandbox ?? new UnavailableHyperVSandboxProvider();
  }

  public async execute(request: ExecutorExecutionRequest): Promise<ExecutorExecutionResult> {
    if (this.controllers.has(request.task.id)) {
      return failureResult(
        request,
        new ExecutorRuntimeError(
          'validation',
          'EXECUTION_ALREADY_ACTIVE',
          'An execution is already active for this task.',
          false,
        ).toFailure(),
      );
    }
    const controller = new AbortController();
    this.controllers.set(request.task.id, controller);
    let binding: Awaited<ReturnType<TaskWorkspaceManager['prepare']>> | undefined;
    let lease: Awaited<ReturnType<SandboxProvider['prepare']>> | undefined;
    try {
      let workspacePath = request.workspacePath;
      if (request.executor === 'agent_cli') {
        if (!workspacePath) {
          throw new ExecutorRuntimeError(
            'sandbox',
            'AGENT_WORKSPACE_REQUIRED',
            'Agent CLI execution requires an authorized workspace.',
            false,
          );
        }
        binding = await this.options.workspaceManager.prepare(request.task.id, workspacePath);
        const provider = ['high', 'critical'].includes(request.task.riskLevel)
          ? this.hypervSandbox
          : this.localSandbox;
        lease = await provider.prepare(binding);
        workspacePath = lease.workspacePath;
      }
      return await this.options.runtime.run(
        request.task,
        {
          signal: controller.signal,
          runId: request.runId,
          attempt: request.attempt,
          approvedToolNames: new Set(request.approvedToolNames),
          ...(workspacePath ? { workspacePath } : {}),
          ...(request.previousSessionId ? { previousSessionId: request.previousSessionId } : {}),
          ...readConversationContext(request.task.metadata),
        },
        request.executor,
      );
    } catch (error: unknown) {
      return failureResult(request, classifyExecutorError(error).toFailure());
    } finally {
      await lease?.dispose();
      if (binding) {
        await this.options.workspaceManager.cleanup(binding);
      }
      this.controllers.delete(request.task.id);
    }
  }

  public cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) {
      return false;
    }
    controller.abort(
      new ExecutorRuntimeError(
        'cancelled',
        'EXECUTOR_CANCELLED',
        `Execution was cancelled: ${taskId}.`,
        false,
      ),
    );
    return true;
  }

  public activeCount(): number {
    return this.controllers.size;
  }
}

function readConversationContext(metadata: Record<string, unknown>): { contextText?: string } {
  const value = metadata.conversationContext;
  return typeof value === 'string' ? { contextText: value.slice(0, 40_000) } : {};
}

function failureResult(
  request: ExecutorExecutionRequest,
  failure: ExecutorFailure,
): ExecutorExecutionResult {
  const status =
    failure.category === 'cancelled'
      ? 'cancelled'
      : failure.category === 'timeout'
        ? 'expired'
        : 'failed';
  return ExecutorExecutionResultSchema.parse({
    taskId: request.task.id,
    runId: request.runId,
    executor: request.executor,
    status,
    events: [],
    failure,
  });
}
