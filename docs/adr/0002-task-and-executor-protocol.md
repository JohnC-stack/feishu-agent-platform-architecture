# ADR-0002：统一任务状态机与执行器事件协议

- 状态：已接受
- 日期：2026-08-20

## 决策

DirectTool、API/ReAct 和 Agent CLI 都实现统一 `Executor` 接口，并通过有序 `ExecutorEvent` 事件返回状态。任务使用固定状态机：`queued`、`running`、`waiting_approval`、`succeeded`、`failed`、`cancelled`、`expired`。

## 原因

- 调度、审批、取消、超时、审计和管理台不应依赖具体模型或 CLI。
- 有序事件可以统一驱动飞书状态卡片、任务时间线和 Trace。
- 固定终态可以阻止已经完成的任务被意外重启。

## 后果

- 执行器不得直接向飞书回复，必须把事件交给回复调度器。
- 每个任务事件的 `sequence` 在任务内唯一且单调递增。
- 新执行器必须通过共享契约和取消测试后才能注册。
