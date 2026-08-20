# 飞书 Agent 平台实施状态

- 更新日期：2026-08-21
- 当前阶段：P3 三类执行器
- 总体状态：P0、P1、P2 已关闭；P3 本地实现和修订后的活动通道验收已完成，API/ReAct 按决策关闭，尚待发布与远端门禁
- 工作分支：`docs/hybrid-architecture-plan`

## P0 任务状态

| 任务                       | 状态   | 当前证据                                                                                          |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `P0-01` 单体仓库与工具链   | 已完成 | Node.js 24.19.0、pnpm 11.19.0；workspace、TypeScript、ESLint、Prettier、Vitest 和构建脚本通过实测 |
| `P0-02` 共享契约           | 已完成 | 任务、状态、风险、执行器事件和健康响应契约具备测试，7 个测试文件、11 个测试全部通过               |
| `P0-03` 数据与本地基础设施 | 已完成 | PostgreSQL 16.15、Redis 7.4.10 健康；首次 migration 与幂等复验通过                                |
| `P0-04` CI 与安全扫描      | 已完成 | 本地检查、生产依赖审计、Gitleaks、远端 CI 与 Security 工作流全部通过                              |
| `P0-05` 架构决策           | 已完成 | 单体仓库、执行器协议和混合部署三份 ADR 已接受                                                     |

## 环境验收记录

- Windows 11 Pro 已启用 WSL 与 VirtualMachinePlatform；WSL 2.7.12.0、内核 6.18.33.2、默认版本 2。
- Docker Desktop 4.86.0 已安装；Docker Server 29.7.2、Compose v5.3.1，`docker-desktop` 以 WSL2 运行。
- PostgreSQL 与 Redis 仅绑定 `127.0.0.1:5432`、`127.0.0.1:6379`，两个容器均为 `healthy`。
- PostgreSQL `pg_isready`、SQL 查询与 Redis `PING` 均成功；数据库版本为 PostgreSQL 16.15，Redis 版本为 7.4.10。
- `0001_platform_core.sql` 首次执行返回 `Applied`，第二次返回 `Database is up to date.`。
- 已核对 migration 登记、5 张业务表、3 个枚举和 4 个关键索引真实存在。

## 已通过验证

- `pnpm install --frozen-lockfile` 成功，依赖构建只允许 `esbuild`。
- `pnpm check` 成功：格式、ESLint、严格类型检查、测试和完整构建全部通过。
- 7 个测试文件、11 个测试全部通过。
- 7 个共享包和 4 个应用全部生成构建产物。
- Control API、Feishu Gateway、Windows Worker 的 `/health/live` 与 `/health/ready` 均返回 `ok`。
- 管理台预览服务的 `/health/live` 与 `/health/ready` 均返回 HTTP 200。
- `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`。
- Gitleaks 8.30.1 对 Git 历史和当前工作区扫描均返回 `no leaks found`。

## 远端验收记录

- P0 基线提交：`f7c74d8`；Linux workspace filter 修复提交：`ba25693`。
- [CI #2](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32350371374) 完成，结论为 `success`。
- [Security #2](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32350371395) 完成，dependency-audit 与 secret-scan 均通过，结论为 `success`。
- 使用 Linux Node 24 容器对提交 `ba25693` 运行冻结依赖安装与完整 `pnpm check`，退出码为 0。

## P0 阶段出口

P0 的环境、实现、测试、运行态、安全和远端流水线门禁已全部通过，于 2026-08-20 关闭。关闭后才将当前阶段更新为 P1。

## P1 阶段出口

- 官方 Node SDK WSS 长连接、自动重连、Redis 事件去重、限流、幂等回复和附件元数据解析已实现。
- 真实测试群 `@机器人 /health` 返回“飞书 WSS 接入、事件去重和回复调度运行正常。”；单聊 `/ping` 返回 `pong`。
- 实时指标记录 2 条真实消息、2 条成功回复，重复、限流和失败均为 0；WSS 与 Redis 健康检查持续为 `ok`。
- 本地 `pnpm check` 通过：13 个测试文件、27 个测试全部成功。
- P1 提交：`e8dc923`；远端 CI `32378199870` 与 Security `32378199945` 均为 `success`。

P1 的实现、自动化测试、真实飞书群聊/单聊、运行态、安全与远端流水线门禁已全部通过，于 2026-08-21 关闭。关闭后才将当前阶段更新为 P2。

## P2 任务状态

P2 环境预检已确认 Node.js 24.19.0、pnpm 11.19.0、Docker Server 29.7.2、PostgreSQL 16.15 和 Redis 7.4.10 可用；PostgreSQL、Redis 与飞书网关均保持健康：

| 任务                              | 状态       | 当前证据                                                                                      |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `P2-01` 任务状态机                | 本地已完成 | 固定转换矩阵、终态保护、转换记录和有序事件已实现并通过契约与真实数据库验证                    |
| `P2-02` BullMQ 调度               | 本地已完成 | 并发、任务去重、超时、指数退避、取消、死信和 Worker stalled 接管均通过真实 Redis 验证         |
| `P2-03` 版本化规则路由            | 本地已完成 | 优先级、启停、版本、条件匹配、fallback 和决策追踪已实现；路由上下文从已校验任务派生           |
| `P2-04` 会话上下文                | 本地已完成 | 渠道、群、用户三元隔离，最近消息、摘要乐观版本控制和消息幂等已通过真实 PostgreSQL 验证        |
| `P2-05` 任务/事件/会话/审计持久化 | 本地已完成 | `0002_p2_scheduling.sql` 已应用并幂等复跑；attempt、route rule、conversation message 表可查询 |

## P2 本地验收记录

- `pnpm check` 成功：格式、ESLint、严格类型检查、16 个测试文件、40 个测试和全部生产构建均通过。
- 持久化验收：任务/消息幂等、会话隔离、有序时间线、终态保护、attempt 记录、路由版本和摘要版本控制全部为 `true`。
- 并发验收：20 个任务覆盖 4 个“群×用户”身份，每个身份唯一会话、身份间会话不同，reply target、correlation ID 和上下文均未串线。
- 队列验收：去重、失败重试、并发度 2、超时、排队取消和独立死信全部为 `true`。
- 恢复验收：子 Worker 强制退出后产生 stalled，备用 Worker 自动接管，任务最终完成。
- 协调器验收：重试 attempt 与最终状态同步写入 PostgreSQL；连续失败后 Redis 死信和数据库死信标记同时生效。
- Control API `/health/ready` 返回 `ok`，`postgres` 与 `bullmq` 均为 `true`；任务提交、查询、规则路由和取消已真实验证。
- `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`。

## P2 阶段出口

P2 本地实现、自动化测试、真实 PostgreSQL/Redis、并发、重试、取消、死信、崩溃恢复和运行态门禁已通过。P2 提交为 `d7a404d`；远端 [CI](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32383751564) 与 [Security](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32383751487) 均为 `success`。P2 于 2026-08-21 关闭，关闭后才进入 P3。

## P3 任务状态

| 任务                                | 状态        | 当前证据                                                                                                                                     |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `P3-01` Executor Adapter            | 本地已完成  | 统一 run、correlation、attempt、序列事件；取消、超时、错误分类和输出协议通过单元测试                                                         |
| `P3-02` DirectTool 与工具网关       | 本地已完成  | 工具注册、Zod 参数校验、任务级白名单、结果截断和 `/ping`/`/health` 零模型路径通过真实 BullMQ 端到端验证                                      |
| `P3-03` Responses API/ReAct         | 已实现/关闭 | OpenAI SDK 7.5.0、Responses 工具循环、API 安全工具别名、最小暴露和冲突拒绝已通过测试；`API_AGENT_ENABLED=false` 时不参与活动路由和 readiness |
| `P3-04` Agent CLI                   | 本地已完成  | 独立 Codex CLI 0.148.0、官方 JSONL、session ID、`resume`、workspace-write 沙箱和真实 BullMQ/数据库链路已通过                                 |
| `P3-05` 工作区、ACL、资源和沙箱接口 | 本地已完成  | 路径逃逸阻断、Windows 用户 ACL、任务目录清理、超时/事件/输出限制已验证；高风险任务在 Hyper-V 未配置时强制拒绝                                |
| `P3-06` 回退与熔断                  | 本地已完成  | 仅对可重试错误回退、无授权工作区时禁止 Agent CLI 回退、阈值熔断和冷却探测通过测试                                                            |

## P3 本地验收记录

- 环境：Node.js 24.19.0、pnpm 11.19.0、Docker 29.7.2、Codex CLI 0.148.0；独立 CLI 已确认使用 ChatGPT 登录，不读取或输出凭据。
- `0003_p3_executor_runtime.sql` 已应用并幂等复跑，新增 executor run、统一 executor event 和 workspace binding 持久化。
- P3 持久化验收：run 创建、事件持久化、审计字段、输出和完整任务重建全部为 `true`。
- Direct 完整链路：Control API 提交、BullMQ、Windows Worker、零模型工具调用、PostgreSQL 终态和事件持久化全部为 `true`。
- Agent CLI 真实验收：JSONL 解析、session 捕获、会话续接、工作区绑定、前后工作区不变和完成状态全部为 `true`；Windows Worker 可在当前进程缺少 `PNPM_HOME` 时从本机 pnpm 安装位置解析真实 Node 入口，避免直接启动 `codex.cmd` 的 `spawn EPERM`。
- Agent CLI 完整链路：路由、输出/session/workspace 持久化、工作区释放、事件落库和工作区不变全部为 `true`。
- Responses API 适配器已完成模拟工具闭环、工具安全别名和冲突拒绝验证；按 2026-08-21 决策，OpenAI API 通道暂时关闭，真实计费 API 不再属于当前 P3 活动通道验收。
- API 关闭门禁：默认关闭；活动执行器列表和 readiness 不包含 `api_agent`；未匹配任务改走 Agent CLI；显式 API 执行请求以不可重试的 `API_AGENT_DISABLED` 失败，不静默回退。
- 故障与安全：活动子进程取消、整体超时、输出/事件上限、未授权工具、工作区逃逸、熔断和高风险 Hyper-V 强制门禁均通过。
- `pnpm check` 成功：格式、ESLint、严格类型检查、23 个测试文件、61 个测试和全部生产构建均通过。
- `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`。

## P3 阶段出口

P3 代码、DirectTool、Agent CLI、数据库、队列、工作区、故障门禁以及 API 关闭门禁已通过本地验收。OpenAI API/ReAct 适配器保留但由 `API_AGENT_ENABLED=false` 强制关闭，不属于当前活动通道出口条件。本阶段代码尚未发布并通过远端 CI/Security；完成发布与远端门禁前，P3 保持未关闭，不进入 P4。
