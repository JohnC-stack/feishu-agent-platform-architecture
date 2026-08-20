# ADR-0001：采用 pnpm TypeScript 单体仓库

- 状态：已接受
- 日期：2026-08-20

## 决策

第一阶段采用 pnpm workspace 管理 Node.js/TypeScript 单体仓库。管理台使用 React/Vite，服务端使用 Fastify，共享代码以内部 workspace package 维护。

## 原因

- 消息、任务、执行器和审计契约可以在 Web、控制面和 Windows Worker 之间统一复用。
- 单次变更可以同时进行类型检查、契约测试和构建验证。
- 在平台边界稳定前，避免多仓库版本协调和发布复杂度。

## 后果

- CI 必须执行全仓 lint、typecheck、test 和 build。
- 共享包变更需要保持向后兼容，破坏性变更必须更新 ADR 和契约测试。
- 后续可以独立部署应用，但不在 P0 拆分代码仓。
