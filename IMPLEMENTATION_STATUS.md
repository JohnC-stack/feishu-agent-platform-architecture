# 飞书 Agent 平台实施状态

- 更新日期：2026-08-22
- 当前阶段：P6 本地、运行态与页面人工验收已全部通过并已推送；等待远端 CI/Security
- 总体状态：P0、P1、P2、P3、P4、P5 已关闭；P6 尚未关闭，未进入 P7
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
- P3 功能提交：`4aa7fe0`；[CI](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32395266254) 与 [Security](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32395266086) 均为 `success`。

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

P3 代码、DirectTool、Agent CLI、数据库、队列、工作区、故障门禁以及 API 关闭门禁已通过本地验收。OpenAI API/ReAct 适配器保留但由 `API_AGENT_ENABLED=false` 强制关闭，不属于当前活动通道出口条件。功能提交 `4aa7fe0` 的远端 CI 与 Security 均为 `success`，P3 于 2026-08-21 关闭；随后按用户指令进入 P4。

## P4 任务状态

| 任务                     | 状态   | 当前证据                                                                                         |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| `P4-01` GitLab 只读      | 已完成 | 仅 `read_api` 令牌、11 个项目、MR、分页差异和流水线完成真实读取；批准项目外默认拒绝              |
| `P4-02` Confluence 只读  | 已完成 | CQL、页面、附件元数据、评论真实读取成功；未批准页面在网络读取前拒绝                              |
| `P4-03` 飞书只读         | 已完成 | 文档、多维表格、测试群和两名精确白名单用户均完成真实读取；全部结果未截断                         |
| `P4-04` 统一接入安全策略 | 已完成 | 精确白名单、origin 锁定、有限退避、限流/超时分类、1 MB 响应上限、20,000 字符截断和凭据脱敏已实现 |
| `P4-05` 模拟与契约测试   | 已完成 | GitLab、Confluence、飞书、HTTP 故障和 Worker/Control 路由均具备自动化测试                        |

## P4 当前验收记录

- P4 定向与全仓门禁：`pnpm check` 通过，31 个测试文件、86 个测试全部成功；格式、Lint、严格 TypeScript、全部构建通过，生产依赖审计无已知漏洞。
- GitLab：GitLab 17.2.9 的个人访问令牌经自检确认仅含 `read_api`；额外 Scope 会以 `GITLAB_TOKEN_SCOPE_NOT_MINIMAL` 阻断所有项目读取。
- GitLab：11 个精确白名单项目、MR 详情、分页差异和流水线详情真实读取成功；差异结果按 20,000 字符上限安全截断。
- GitLab Job：11 个批准项目的 Job API 均返回 HTTP 200、数量 0；不为验收触发写操作，真实日志读取记为不适用，日志截断与 Token 脱敏契约测试通过。
- Confluence：公司 VPN、DPAPI 保存凭据、个人测试空间的页面、附件元数据、评论、CQL 搜索均真实通过。
- Worker 实机：Windows Worker 与 Control API 重启成功，`phase=P4`、readiness HTTP 200，GitLab、Confluence、飞书均显示已配置。
- Worker 越权门禁：批准页面读取成功且不调用模型；未批准页面以不可重试的 `RESOURCE_NOT_APPROVED` 失败。
- Control API 全链路：`/confluence` 与 `/gitlab project` 均经规则路由、BullMQ、Windows Worker 和 PostgreSQL 单次执行后成功，路由规则为 `enterprise-read-direct`，未调用模型。
- 飞书：tenant token 鉴权成功；测试文档、多维表格、唯一测试群以及两名精确白名单用户共 5 次真实只读调用全部成功，结果未截断。
- 飞书通讯录：同时使用 `contact:contact.base:readonly` 基础 API 权限和 `contact:user.base:readonly` 基本字段权限；未申请手机号、邮箱、员工编号等敏感字段权限。
- 三系统统一验收：GitLab 15 项、Confluence 3 项、飞书 5 项，共 23 项真实检查全部通过。
- 网络例外：公司 GitLab 当前仅提供内网 HTTP `192.168.27.20:8000`；P4 仅按开发环境验收，生产准入前必须升级 HTTPS 或置于可信 TLS 反向代理之后。

## P4 阶段出口

P4 的实现、契约测试、权限边界、三系统真实联调、运行态、全仓门禁和依赖审计已全部通过，于 2026-08-21 关闭。随后按用户指令进入 P5；GitLab TLS 改造作为生产准入项保留到 P8，不能在生产验收中豁免。

## P5 任务状态

| 任务                   | 状态   | 当前证据                                                                                 |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `P5-01` RBAC           | 已完成 | 用户/群组角色、工具可见性、资源范围、未知身份默认拒绝和运行态角色分离均通过              |
| `P5-02` 写操作审批     | 已完成 | WSS 立即回传终态卡、异步更新兜底、单卡单终态、职责分离、中文状态与数据库审计全部通过     |
| `P5-03` 写操作幂等     | 已完成 | 同键同载荷复用、同键异载荷冲突、数据库原子执行声明和重复决策冲突均通过                   |
| `P5-04` Token/成本预算 | 已完成 | 用户、群、任务、模型四层限制及并发原子预留通过真实 PostgreSQL 验收                       |
| `P5-05` 审计与脱敏     | 已完成 | 操作人、权限、资源、结果、保留期、递归脱敏和受控导出通过                                 |
| `P5-06` 凭据引用       | 已完成 | 飞书与 GitLab 明文迁出 `.env`，Windows Credential Manager 引用、前缀限制和序列化保护通过 |

## P5 当前验收记录

- `0004_p5_governance.sql` 已应用；RBAC、未授权隐藏、审批门禁、职责分离、幂等、单次执行、拒绝、过期、撤销、分层预算、脱敏审计和凭据仅引用共 12 项检查全部为 `true`。
- Control API 运行态：operator 可见 6 个批准工具但不能审批；approver 可审批；未知身份可见工具为 0。未授权审批和审计导出均返回 HTTP `403`。
- 高风险写操作创建后为 `pending_approval/pending`；同键同载荷返回 HTTP `200` 且不重建，同键异载荷与重复审批返回 HTTP `409`。
- 首次界面验收发现仅依赖消息更新 API 时客户端按钮未消失；现已改为通过 WSS 回调立即返回无按钮终态卡，并在响应后异步调用消息更新 API 兜底。幂等键收紧为每张审批卡唯一，重复操作复用已缓存终态。
- 修复后连续两张真实审批卡均完成单次 WSS 批准，`approved=1`、`duplicate=0`、`failed=0`、异步卡片更新失败为 0；用户确认卡片样式已切换、按钮消失，原审批详情得到保留，审批与操作状态显示中文。
- 两次修复后真实审批数据库验收均通过：审批与操作均为 `approved`，申请人与审批人不同，决策时间和版本已更新，`approval.approve` 审计事件存在。
- 待审批卡和终态卡的过期时间统一按北京时间显示为 `yyyy-MM-dd HH:mm:ss`；自动化测试覆盖 ISO 时间到界面格式的确定性转换。
- Worker 启动时从 Windows Credential Manager 解析 2 个凭据引用；合成凭据实机验证后已删除，真实 Secret 未输出。
- P4 三系统真实回归共 23 项全部通过，凭据迁移未造成 GitLab、Confluence 或飞书只读能力回退。
- `pnpm check` 成功：37 个测试文件、106 个测试、格式、Lint、严格类型检查和全部生产构建通过。
- `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`；`.env` 未被 Git 跟踪，当前差异未发现疑似明文凭据。
- P5 功能提交为 `195dc3d`；门禁修复提交 `218379e` 补齐全新 Linux 环境下的 credentials 工作区源码解析，并消除两项纯测试值的密钥扫描误报。
- `218379e` 的远端 [CI](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32456476006) 与 [Security](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32456476059) 工作流均为 `success`。

## P5 阶段出口

P5 的实现、迁移、自动化测试、真实 PostgreSQL、Windows Credential Manager、企业系统回归、运行态 RBAC、真实飞书审批卡片点击、WSS 回调去重、共享卡片终态更新、审计、本地依赖安全门禁及远端 CI/Security 已全部通过。P5 于 2026-08-21 正式关闭；P6 尚未开始，等待明确启动指令。

## P6 任务状态

| 任务                     | 状态       | 当前证据                                                                                              |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------- |
| `P6-01` 核心运行页面     | 本地已完成 | 总览、任务与会话、队列与 Worker、执行器与沙箱均使用真实聚合数据                                       |
| `P6-02` 治理与配置页面   | 本地已完成 | 集成、审批、用户与角色、Token/成本、配置页面已接入 RBAC；角色绑定管理、服务端过滤和页面验收均已通过   |
| `P6-03` 可观测性与告警   | 本地已完成 | 日志与 Trace、健康、失败任务、模型失败、队列积压、服务离线和预算告警已实现                            |
| `P6-04` 发布、备份与恢复 | 本地已完成 | 发布、备份、配置版本和恢复记录具备数据表、聚合 API 与可视化页面                                       |
| `P6-05` 受治理运维操作   | 本地已完成 | 取消、重试、清理、重启和回滚要求精确中文确认；高风险操作审批前保持 `pending_approval`，所有写入均审计 |

## P6 当前验收记录

- `0005_p6_operations.sql` 已应用并通过幂等复跑；告警、运维操作、服务实例、发布、备份和配置版本表已创建。
- P6 数据库专项检查 13 项全部为 `true`：任务聚合、事件 Trace、告警创建/确认/持久化、运维审计、发布、备份、配置版本、零 Secret 配置、受管角色绑定增删和 Bootstrap 绑定保护。
- Control API 已提供受 RBAC 保护的管理快照、任务 Trace、告警确认和运维操作接口；未提供管理身份时 fail-closed。
- 真实运行态专项检查 12 项全部为 `true`：三服务健康、飞书唯一交互登录、普通/超级管理员入口、本机与手工身份绕过关闭、模拟飞书失败任务、来源与 correlation 持久化、执行 Trace、失败持久化和公开认证配置零 Secret。
- 原 13 页信息架构因用户反馈“排版效果差、管理能力不足”重新打开视觉门禁；当前重组为管理驾驶舱、运行管理、安全治理、平台运维和帮助五组共 14 页，并新增角色管理与操作说明书。
- 登录界面只保留飞书 OAuth；普通成员与超级管理员使用独立入口但共用安全回调。超级管理员入口不产生提权，只接受已有 `administrator` 绑定；本机 Bootstrap 与手工 Open ID 入口在运行配置中关闭。
- 管理台正式身份入口已升级为飞书 OAuth 2.0：授权入口与 Token 交换按官方实现配对使用 `authen/v1/authorize` 和 `authen/v2/oauth/token`，并启用单次 `state`、43 字符 verifier 的 S256 PKCE、服务端用户信息读取和 HttpOnly 平台会话；飞书 Token 不进入浏览器或持久化。回调 URL 已在“机器人”应用发布生效；修复 OAuth v3 端点返回 `20049` 的协议版本错配后，用户于 2026-08-22 确认真实飞书授权成功，并进入受管理员 RBAC 保护的 `#alerts` 页面。服务端同期记录 0 条 OAuth 错误、0 个 HTTP 401。
- 新版页面改为 260px 分组导航、最大宽度内容区、管理快捷入口、角色范围提示和响应式布局；功能、交互、接口固化到 `docs/p6-admin-ui-spec.md`，日常操作固化到 `docs/p6-admin-operation-manual.md`。用户于 2026-08-22 确认 14 个页面、视觉布局、窄屏布局、中文状态、空态与错误提示人工验收完成。
- 三个本机服务已加载 P6 构建：Control API、Feishu Gateway、Windows Worker 的 readiness 均为 `ok`；飞书 WSS、Redis、PostgreSQL、BullMQ、Windows Worker 与 Codex CLI 检查均通过。
- P5 数据库治理 12 项全部回归通过；连接 MotionPro 企业 VPN 后，P4 GitLab 15 项、Confluence 3 项、飞书 5 项，共 23 项真实只读回归全部通过。
- `pnpm check` 成功：40 个测试文件、130 个测试、格式、Lint、严格类型检查和全部生产构建通过；OAuth v2 端点修复后，飞书 OAuth 定向测试、严格类型检查和 Control API 生产构建再次通过。
- `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`。
- 无会话访问 `/v1/admin/session` 与 `/v1/admin/snapshot` 均返回 `401 ADMIN_SESSION_REQUIRED`，已关闭的本机 Bootstrap 入口返回 `404`；管理台不再依赖模糊的 `400` 判断会话失效。角色隔离、超级管理员限定、角色绑定增删、Bootstrap 保护、告警确认、精确风险确认、待审批运维操作和审计记录通过 21 项定向接口测试及真实 PostgreSQL 专项。用户通过页面完成一组非启动配置的群组 `reader` 绑定新增与删除；新增审计为 `succeeded`、删除审计为 `deleted`，复核无残留绑定，真实页面写操作门禁通过。

## P6 阶段出口

P6 的底层迁移、真实 PostgreSQL/Redis、三服务运行态、飞书真实登录、典型失败 Trace、告警、配置脱敏、风险确认、前置阶段回归、新版管理中心人工视觉验收和真实页面角色绑定增删审计均已通过。P6 保持开启状态，不进入 P7；剩余门禁仅为经用户授权的提交推送和远端 CI/Security。
