# 飞书 Agent 平台

[![CI](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/workflows/ci.yml/badge.svg?branch=docs%2Fhybrid-architecture-plan)](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/workflows/ci.yml?query=branch%3Adocs%2Fhybrid-architecture-plan)
[![Security](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/workflows/security.yml/badge.svg?branch=docs%2Fhybrid-architecture-plan)](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/workflows/security.yml?query=branch%3Adocs%2Fhybrid-architecture-plan)

面向企业内网的飞书 Agent 管理与执行平台。它把飞书消息接入、确定性工具、Agent CLI、企业系统、RBAC、审批、审计、管理中心、监控告警、发布回滚和备份恢复整合到同一条可治理链路中。

> **当前状态：P0–P7 已完成并关闭，P8 尚未开始。** 2026-08-26 的实机验收版本为 `0.7.0-p7rc1`。OpenAI API/ReAct 通道保留实现但固定设置为 `API_AGENT_ENABLED=false`，不参与活动路由、回退或 readiness。

## 项目定位

平台解决的不是单一“聊天机器人”问题，而是企业内部 Agent 的完整运行与治理问题：

- 飞书私聊、群聊 `@机器人` 和卡片交互统一接入；
- 明确命令优先走零模型 Token 的确定性工具；
- 代码、本地文件和重型任务进入受控 Agent CLI；
- GitLab、Confluence、飞书文档和多维表格按精确白名单读取；
- 写操作经过 RBAC、风险分级、职责分离、审批和幂等保护；
- 管理人员通过飞书 OAuth 登录可视化管理中心；
- Windows 执行面与 Linux 控制面通过内部 mTLS 协作；
- 任务、队列、执行器、审批、告警、发布和恢复均可追踪、可审计、可回滚。

## 当前里程碑

| 阶段 | 状态   | 已交付内容                                                 |
| ---- | ------ | ---------------------------------------------------------- |
| P0   | 已关闭 | 单体仓库、共享契约、PostgreSQL/Redis、CI 与安全门禁        |
| P1   | 已关闭 | 飞书 WSS 接入、事件去重、限流、幂等回复和真实消息验收      |
| P2   | 已关闭 | 任务状态机、BullMQ、规则路由、会话隔离和持久化             |
| P3   | 已关闭 | DirectTool、Agent CLI、API Agent 适配器和执行安全边界      |
| P4   | 已关闭 | GitLab、Confluence、飞书只读接入和企业资源白名单           |
| P5   | 已关闭 | RBAC、飞书审批卡、写操作幂等、预算、审计和凭据引用         |
| P6   | 已关闭 | 14 页管理中心、飞书 OAuth、角色管理、告警和运维操作        |
| P7   | 已关闭 | Windows Service、Linux VM 控制面、mTLS、发布回滚和备份恢复 |
| P8   | 未开始 | 压测、安全测试、故障演练、企业 CA、UAT 和生产准入          |

完整任务与验收条件见 [实施计划](IMPLEMENTATION_PLAN.md)，逐阶段实测证据见 [实施状态](IMPLEMENTATION_STATUS.md)。

## 已验收运行基线

| 项目           | 当前实机状态                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动版本       | `0.7.0-p7rc1`                                                                                                                                                                                                                |
| Windows 执行面 | Gateway、Worker 均为 `LocalService / Automatic / Running`                                                                                                                                                                    |
| Linux 控制面   | Ubuntu 24.04.4 Hyper-V VM，地址 `192.168.100.10`                                                                                                                                                                             |
| 容器           | PostgreSQL、Redis、Control API、Edge、Prometheus、Grafana 共 6 个                                                                                                                                                            |
| 内部服务身份   | Gateway、Worker、Control API 三条 mTLS 通道已通过正向与无证书拒绝测试                                                                                                                                                        |
| 监控           | Control API、Gateway、Worker 三个 Prometheus 目标均为 `up`                                                                                                                                                                   |
| 重启恢复       | Windows 整机重启后的服务、VM、systemd、容器、防火墙和任务链路 15/15 通过                                                                                                                                                     |
| 发布演练       | Linux 与 Windows 均完成 `p7rc1 → p7rc2 → p7rc1` 升级、健康检查和回滚                                                                                                                                                         |
| 恢复演练       | 加密备份、逐文件哈希、5 条 migration、Redis `PONG` 和独立项目恢复全部通过                                                                                                                                                    |
| 自动化质量门禁 | 41 个测试文件、138 个测试、Lint、严格类型检查和全部生产构建通过                                                                                                                                                              |
| 远端门禁       | P7 [CI](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32875385999) 与 [Security](https://github.com/JohnC-stack/feishu-agent-platform-architecture/actions/runs/32875385943) 均为 `success` |

P7 的实机验收主机是 Windows 11 Pro 25H2。目标生产环境仍应使用公司批准的 Windows Server、企业 CA 和服务账号安全基线。

## 网络拓扑

![飞书 Agent 平台网络拓扑](diagrams/network-topology-v3.png)

- 当前矢量图：[network-topology-v3.svg](diagrams/network-topology-v3.svg)
- 历史版本：[network-topology-v2.svg](diagrams/network-topology-v2.svg)

核心网络原则：

1. Feishu Gateway 主动建立 WSS 443 长连接，不配置公网事件回调入口。
2. 飞书事件沿已建立连接进入，回复通过飞书 OpenAPI 的出站 HTTPS 443 发送。
3. Windows 原生服务直接使用 Windows 凭据、VPN、Git、本机工作区和 Agent CLI。
4. Web、Control API、Redis、PostgreSQL 和可观测性运行在 Hyper-V Linux VM 中。
5. Windows 与 Linux VM 之间只开放精确来源、精确端口，并强制内部 TLS/mTLS。
6. PostgreSQL、Control API、Prometheus 和 Grafana 不直接暴露宿主端口。
7. 管理中心只允许公司内网或 VPN 访问，不向公网开放。
8. Docker Desktop 仅用于本地开发，不是生产运行依赖。

### 内部端口边界

| 目标            | 端口     | 允许来源         | 用途                          |
| --------------- | -------- | ---------------- | ----------------------------- |
| Linux VM        | 22/TCP   | `192.168.100.1`  | SSH 运维                      |
| Linux VM        | 443/TCP  | `192.168.100.1`  | 管理台、API、Control mTLS     |
| Linux VM        | 6379/TCP | `192.168.100.1`  | Gateway 到 Redis 的 TLS 连接  |
| Windows Gateway | 3100/TCP | `192.168.100.10` | mTLS 健康检查与指标           |
| Windows Worker  | 3200/TCP | `192.168.100.10` | mTLS 任务执行、健康检查与指标 |

不得把来源扩大为 `Any`，不得增加公网端口转发。

## 技术架构

![飞书 Agent 平台技术架构](diagrams/technical-architecture-v2.png)

- 当前矢量图：[technical-architecture-v2.svg](diagrams/technical-architecture-v2.svg)
- 历史版本：[technical-architecture-v1.svg](diagrams/technical-architecture-v1.svg)

### 一条任务的完整链路

```text
飞书 WSS 事件
  → Feishu Gateway：验签、解析、去重、限流、回复目标
  → Control API：身份、RBAC、风险、预算、幂等、规则路由
  → PostgreSQL + BullMQ：任务、会话、attempt、审计、调度
  → Windows Worker：DirectTool / Agent CLI / 已关闭的 API Agent
  → 企业系统或本地工作区
  → 执行事件、结果、告警和审计回写
  → 飞书文本、卡片或管理中心展示
```

### 核心应用

| 应用             | 职责                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `admin-web`      | React 管理中心、飞书登录、运行管理、安全治理、平台运维和操作说明书 |
| `control-api`    | 任务入口、路由、队列协调、RBAC、审批、预算、审计和管理 API         |
| `feishu-gateway` | 飞书 WSS、事件去重、回复调度、审批卡片和卡片回调                   |
| `windows-worker` | 企业只读工具、DirectTool、Agent CLI、工作区和 Windows 本机能力     |

### 共享包

| 包              | 职责                                                  |
| --------------- | ----------------------------------------------------- |
| `contracts`     | 任务、执行器、风险、审批、健康和传输契约              |
| `credentials`   | Windows Credential Manager 与企业密钥提供方抽象       |
| `database`      | PostgreSQL migration、存储和阶段验收脚本              |
| `executors`     | DirectTool、Agent CLI、API Agent 适配器与统一执行事件 |
| `integrations`  | GitLab、Confluence、飞书只读适配器和安全 HTTP 策略    |
| `observability` | 健康、指标、Trace、日志脱敏和错误分类                 |
| `policy`        | 工具白名单、资源范围、工作区和执行策略                |
| `testing`       | 测试基础设施与共享断言                                |
| `transport`     | Windows/Linux 跨主机 mTLS 传输和证书身份校验          |

## 执行器与路由

平台先运行普通规则程序，再决定是否调用模型：

| 场景                                  | 执行器                           | 模型 Token |
| ------------------------------------- | -------------------------------- | ---------: |
| `/gitlab`、`/confluence`、`/feishu`   | `DirectToolExecutor`             |          0 |
| `/ping`、健康检查、固定报表和明确查询 | `DirectToolExecutor`             |          0 |
| 代码分析、修改、测试和本地文件任务    | `AgentCliExecutor`               | 按任务产生 |
| 自然语言跨系统组合与摘要              | `ApiAgentExecutor`，当前强制关闭 | 按任务产生 |

所有执行器使用统一的 run、correlation ID、attempt、事件、取消、超时、错误和审计协议。写操作无论由哪个执行器执行，都必须经过治理层。

### DirectToolExecutor

- 处理确定性命令、固定查询和经过批准的写操作；
- 不调用模型，模型 Token 为 0；
- 工具调用必须命中白名单、参数 Schema、资源范围和幂等规则；
- 返回内容经过大小限制、截断和递归脱敏。

### AgentCliExecutor

- 当前接入 Codex CLI JSONL 事件和会话续接；
- 工作区必须位于授权根目录，并经过真实路径和 Windows ACL 复核；
- 支持超时、取消、输出上限、工作区释放和任务后清理；
- 高风险或不可信任务必须使用强隔离环境，普通容器不是唯一安全边界。

### ApiAgentExecutor

- Responses API/ReAct/Function Calling 风格的适配实现已保留；
- 当前 `API_AGENT_ENABLED=false`，不出现在活动执行器列表和 readiness 中；
- 未匹配任务不会静默进入 API Agent；显式请求会以不可重试错误拒绝；
- 后续只有经过安全、成本和数据边界重新评审后才能启用。

## 企业系统接入

P4 当前只开放读取能力，写入、评论、合并、创建和删除不属于只读接入范围。

| 系统       | 已实现读取能力                         | 边界                                               |
| ---------- | -------------------------------------- | -------------------------------------------------- |
| GitLab     | 项目、MR、分页差异、流水线、Job 日志   | 仅 `read_api`，11 个批准项目，精确项目白名单       |
| Confluence | CQL 搜索、页面、附件元数据、评论       | 空间和页面双重白名单，复用 VPN 与受保护 CLI 凭据   |
| 飞书       | 新版文档、多维表格、群组、用户基本信息 | 应用权限、资源协作者权限、数据范围和本机白名单并用 |

确定性命令示例：

```text
/gitlab project <project-path>
/gitlab mr <project-path> <mr-iid>
/confluence page <space-key> <page-id>
/feishu document <document-id>
/feishu bitable <app-token>
/feishu chat <chat-id>
/feishu user <open-id-or-user-id>
```

空白名单一律拒绝，不会退化为“允许全部”。当前公司 GitLab 的内网 HTTP 链路只属于开发验收例外；生产前必须升级为 HTTPS 或置于可信 TLS 反向代理之后。

## 治理、审批与审计

### 角色

| 角色            | 主要能力                                                 |
| --------------- | -------------------------------------------------------- |
| `reader`        | 查看运行状态，调用批准范围内的只读工具                   |
| `operator`      | 申请执行受治理的 Agent CLI 和运维操作                    |
| `approver`      | 批准、拒绝和撤销审批，但不能审批自己的申请               |
| `auditor`       | 查看和导出递归脱敏后的审计事件                           |
| `administrator` | 管理角色、告警、运维和治理能力，仍受审批、幂等与审计约束 |

角色可绑定用户或群组。未知身份默认可见工具为 0，隐藏菜单不是权限边界，所有 API 都会再次执行服务端授权。

### 高风险写操作

1. 校验请求人角色、工具和资源范围；
2. 以规范化载荷哈希和幂等键创建受治理操作；
3. 向飞书群发送审批卡片；
4. 审批人通过 WSS 卡片回调批准或拒绝；
5. Control API 校验审批角色、职责分离和状态机；
6. 飞书立即返回移除按钮的中文终态卡，并异步更新原消息兜底；
7. 只有 `approved` 操作可以原子声明执行，重复声明不会重复写入。

待审批与终态卡的过期时间统一使用北京时间 `yyyy-MM-dd HH:mm:ss`。审批卡保留工具、资源、风险、申请人和过期时间，并追加中文审批状态、操作状态和审批人。

### 预算与凭据

- Token/成本限制同时覆盖用户每日、群组每日、单任务和模型每日；
- 预算在入队前通过 PostgreSQL 原子预留，任一层级超限均拒绝任务；
- 飞书 App Secret 和 GitLab Token 使用 Windows Credential Manager 引用；
- `.env`、数据库、管理 API、日志和管理页面都不得返回明文凭据；
- Gitleaks、生产依赖审计和递归脱敏属于持续质量门禁。

## 管理中心

管理中心由 5 个分组、14 个页面组成：

| 分组     | 页面                                              |
| -------- | ------------------------------------------------- |
| 总览     | 管理驾驶舱                                        |
| 运行管理 | 任务与会话、队列与 Worker、执行器与沙箱、系统集成 |
| 安全治理 | 审批中心、用户与权限、Token 与成本、日志与 Trace  |
| 平台运维 | 告警中心、配置中心、发布与备份、运维操作          |
| 帮助     | 操作说明书                                        |

正式登录只使用飞书 OAuth 2.0：

- 授权入口与 Token 交换按飞书协议版本正确配对；
- 使用单次 `state`、S256 PKCE 和服务端用户信息读取；
- 飞书 Token 用完即丢弃，浏览器只接收平台 `HttpOnly + SameSite=Lax` 会话；
- 普通成员入口和超级管理员入口共用安全回调；
- 超级管理员入口不会提权，只接受已经绑定 `administrator` 的飞书用户；
- 本机 Bootstrap 和手工 Open ID 登录在正式运行配置中关闭。

本地入口：

- 普通成员：<http://127.0.0.1:5173/#overview>
- 超级管理员：<http://127.0.0.1:5173/#super-admin-login>
- OAuth 回调：<http://127.0.0.1:5173/v1/admin/auth/feishu/callback>

页面、交互和接口详见 [管理中心规范](docs/p6-admin-ui-spec.md)，日常使用详见 [管理中心操作说明书](docs/p6-admin-operation-manual.md)。

## 混合部署

| 部署位置                  | 组件                                                           | 目的                                            |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Windows 原生服务          | Feishu Gateway、Windows Worker、Agent CLI、工作区              | 直接使用 Windows 凭据、VPN、Git、路径和本机 CLI |
| Hyper-V Linux VM / Docker | Edge、Web、Control API、Redis、PostgreSQL、Prometheus、Grafana | 隔离依赖，统一升级、备份、监控和迁移            |
| Hyper-V 强隔离环境        | 高风险或不可信任务                                             | 提供强于普通进程或普通容器的隔离边界            |

### 当前实机目录

```text
D:\FeishuAgent\program      # Windows 不可变发布包、current 联接和服务包装器
D:\FeishuAgent\data         # 配置、证书、日志、状态和任务数据
D:\FeishuAgent\backups      # Windows 迁移与升级前备份
D:\Hyper-V                   # VM 配置、VHDX 和检查点
/opt/feishu-agent            # Linux 控制面程序、配置和部署资产
```

Windows 发布包通过 SHA256 清单校验，使用目录联接原子切换版本；Linux 发布依次执行配置校验、镜像构建、数据库 migration、无队列消费金丝雀、健康检查和活动版本切换。数据库 migration 必须向后兼容，回滚不依赖自动降级 SQL。

生产部署与日常运维入口：

- [Windows 执行面部署](deploy/windows/README.md)
- [Linux 控制面部署](deploy/docker/README.md)
- [P7 混合部署运维手册](docs/p7-hybrid-deployment-operation-manual.md)
- [备份、恢复与演练](deploy/backup/README.md)

## 本地开发

### 前置条件

- Windows 11 或 Windows Server 2022；
- Node.js 22–24；
- pnpm 10–11，项目验证版本为 11.19.0；
- Docker Engine 或 Docker Desktop，仅用于本地 PostgreSQL/Redis；
- Git；
- Agent CLI 任务需要安装 Codex CLI 并完成本机安全登录。

### 首次启动

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev:infra
pnpm db:migrate
pnpm check
pnpm dev
```

`.env` 已被 Git 忽略，只允许保存本地配置或受保护凭据引用，不得提交真实 Secret。

### 本地地址

| 组件                    | 地址                    |
| ----------------------- | ----------------------- |
| 管理中心                | <http://127.0.0.1:5173> |
| Control API             | <http://127.0.0.1:3000> |
| Feishu Gateway 健康服务 | <http://127.0.0.1:3100> |
| Windows Worker 健康服务 | <http://127.0.0.1:3200> |

动态服务均提供 `/health/live` 和 `/health/ready`。完整环境准备、飞书配置和专项验收命令见 [本地开发指南](docs/development.md)。

### 常用命令

```powershell
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm audit --prod --audit-level high
pnpm dev:infra:down
```

阶段验收要求使用 `pnpm install --frozen-lockfile` 和 `pnpm check`，不得因为 Docker、数据库、VPN 或企业系统不可用而把未执行的真实联调标记为通过。

## 质量与验收

当前 P7 关闭门禁包括：

- Prettier、ESLint、严格 TypeScript、41 个测试文件、138 个测试和完整生产构建；
- PowerShell 5.1 与 PowerShell 7 的 Windows 部署资产兼容性；
- Linux Shell 语法、Compose 边界、UFW 和端口发布检查；
- `pnpm audit --prod --audit-level high` 无已知漏洞；
- Gitleaks 对可提交源码、部署资产、文档和 Git 历史扫描通过；
- 飞书 WSS、OAuth、审批卡、GitLab、Confluence、飞书资源和 Agent CLI 的真实联调；
- Windows 重启后 15 项自动恢复与新的 `/ping` 全链路任务；
- Linux/Windows 双侧升级、健康检查、回滚和回滚后任务；
- 加密备份、逐文件哈希与独立项目恢复演练；
- GitHub Actions CI 与 Security 工作流。

自动化契约测试不能替代真实企业系统、浏览器、重启、证书和恢复演练。每个阶段只有在对应真实门禁也通过后才能关闭。

## 安全边界

- 生产环境不开放公网入站端口；
- 管理中心只允许公司内网或 VPN 访问，并使用 HTTPS；
- Windows/Linux 内部调用使用 mTLS 和精确防火墙来源；
- 企业系统使用独立服务账号、最小权限和精确资源白名单；
- 读写工具分离，高风险写操作必须审批；
- Agent 只能访问授权工作区、命令和网络目标；
- Secret 不进入 Git、聊天、日志、数据库返回或管理页面；
- 审计记录覆盖消息、路由、预算、工具、审批、执行器和管理写操作；
- 普通容器不能作为不可信 Agent 的唯一隔离边界。

P7 实机使用受保护的测试 PKI。它只用于阶段验收，不是最终生产证书基线。

## 仓库结构

```text
.
├── .github/workflows       # CI 与 Security
├── apps
│   ├── admin-web           # React 管理中心
│   ├── control-api         # 任务、治理和管理 API
│   ├── feishu-gateway      # 飞书 WSS 与回复/审批卡
│   └── windows-worker      # 工具、Agent CLI 与 Windows 执行面
├── packages
│   ├── contracts           # 共享契约
│   ├── credentials         # 凭据提供方
│   ├── database            # PostgreSQL 与 migration
│   ├── executors           # 执行器适配器
│   ├── integrations        # 企业系统只读接入
│   ├── observability       # 健康、指标、Trace 与脱敏
│   ├── policy              # 工具、资源和工作区策略
│   ├── testing             # 测试支持
│   └── transport           # 跨主机 mTLS 传输
├── deploy
│   ├── backup              # 加密备份、恢复和演练
│   ├── docker              # Linux VM 生产控制面
│   └── windows             # Windows Service、Hyper-V 与发布脚本
├── diagrams                # 网络与技术架构图
├── docs                    # ADR、开发、治理、管理和运维文档
├── IMPLEMENTATION_PLAN.md  # 完整实施计划
├── IMPLEMENTATION_STATUS.md # 实际验收记录
└── README.md
```

## 文档导航

| 文档                                                         | 内容                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| [实施计划](IMPLEMENTATION_PLAN.md)                           | P0–P8 任务、阶段门禁、测试策略、风险与排期             |
| [实施状态](IMPLEMENTATION_STATUS.md)                         | 每个阶段的真实运行、页面、CI 和安全验收证据            |
| [本地开发指南](docs/development.md)                          | Windows 环境准备、启动、端口、配置和专项验证           |
| [企业系统接入](docs/p4-enterprise-integrations.md)           | GitLab、Confluence、飞书只读权限和白名单               |
| [治理与审批](docs/p5-governance-and-approval.md)             | RBAC、审批、幂等、预算、审计和凭据                     |
| [管理台与运维](docs/p6-admin-and-operations.md)              | 管理 API、告警、Trace、OAuth 和运维操作                |
| [管理中心页面规范](docs/p6-admin-ui-spec.md)                 | 14 个页面的原型、状态、交互和接口                      |
| [管理中心操作说明书](docs/p6-admin-operation-manual.md)      | 登录、角色、日检、告警、运维和审计流程                 |
| [P7 运维手册](docs/p7-hybrid-deployment-operation-manual.md) | 正式拓扑、健康、启停、发布、回滚和故障定位             |
| [架构决策记录](docs/adr/0001-monorepo-and-runtime.md)        | 单体仓库与运行时边界；同目录还包含执行器和混合部署 ADR |

## P8 生产准入事项

P8 尚未启动。在进入生产试运行前，至少需要完成：

1. 使用企业 CA 替换 P7 测试 PKI，并完成证书轮换和吊销演练；
2. 由安全团队确认 `LocalService` 是否切换为专用域服务账号及最小 ACL；
3. 把 GitLab 开发 HTTP 例外升级为 HTTPS 或可信 TLS 反向代理；
4. 完成并发、峰值、长稳和容量压测；
5. 完成 Prompt 注入、越权、工作区逃逸、凭据泄漏和依赖攻击测试；
6. 完成网络中断、依赖超时、进程崩溃、主机重启和数据库恢复故障演练；
7. 完成试点用户 UAT、运维交接、监控阈值确认和生产准入评审；
8. 保持 API/ReAct 通道关闭，除非收到明确启用指令并完成独立安全与成本评审。

P8 的任务、出口标准和风险清单以 [实施计划](IMPLEMENTATION_PLAN.md) 为准。
