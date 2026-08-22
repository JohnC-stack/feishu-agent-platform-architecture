# P6 管理台与运维

## 范围与门禁

P6 将 P0 的静态管理台骨架升级为真实数据驱动的运维中心。所有读取先经过 P5 RBAC；管理写操作要求精确风险确认并写入审计。取消任务可以在授权后执行；重试、资源清理、服务重启和版本回滚在批准前仅登记为 `pending_approval`，P7 才实现部署层执行器。

当前实现、数据库迁移、自动化测试、运行态 API、典型失败链路、企业系统回归、本地安全门禁、界面人工视觉验收和真实页面角色绑定增删审计均已通过。P6 尚未关闭：仅待授权提交推送和远端 CI/Security。

## 管理台页面

| 分组     | 页面                                              | 数据来源                                       |
| -------- | ------------------------------------------------- | ---------------------------------------------- |
| 总览     | 管理驾驶舱                                        | 聚合健康、任务、审批、告警和当前角色能力       |
| 运行管理 | 任务与会话、队列与 Worker、执行器与沙箱、系统集成 | PostgreSQL、BullMQ、三服务 readiness、集成摘要 |
| 安全治理 | 审批中心、用户与权限、Token 与成本、日志与 Trace  | P5 RBAC/审批/预算、task/executor/audit event   |
| 平台运维 | 告警中心、配置中心、发布与备份、运维操作          | alert、release/backup/config/admin tables      |
| 帮助     | 操作说明书                                        | 角色工作流、权限矩阵和安全操作守则             |

配置页面只返回键名、是否配置、来源和是否需要重启。它不返回实际值；Secret、令牌、Cookie、连接串和凭据引用仍经过递归脱敏。

## Control API

| 方法     | 路径                                      | 权限/行为                                                    |
| -------- | ----------------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/v1/admin/auth/config`                   | 公共安全配置；只返回登录能力开关                             |
| `GET`    | `/v1/admin/auth/feishu/start`             | 普通成员入口；生成单次 state、S256 PKCE 并跳转飞书授权页     |
| `GET`    | `/v1/admin/auth/feishu/super-admin/start` | 超级管理员入口；state 绑定登录模式，不提升用户原有角色       |
| `GET`    | `/v1/admin/auth/feishu/callback`          | 校验回调和登录模式、获取飞书身份并签发 HttpOnly 会话         |
| `GET`    | `/v1/admin/session`                       | 返回显示名、角色、能力、来源和到期时间                       |
| `POST`   | `/v1/admin/session/logout`                | 撤销服务端会话并清除 Cookie                                  |
| `GET`    | `/v1/admin/snapshot`                      | 已绑定平台角色；按 `allowedPages` 在服务端过滤聚合读取模型   |
| `GET`    | `/v1/admin/tasks/:taskId/trace`           | 允许 Trace 页面；关联任务、attempt、run、事件                |
| `POST`   | `/v1/admin/alerts/:alertId/acknowledge`   | `alert.manage`；确认告警并审计                               |
| `POST`   | `/v1/admin/actions`                       | `admin.operate`；校验目标类型和精确确认文本                  |
| `POST`   | `/v1/admin/access/role-bindings`          | `access.manage`；新增用户/群组角色绑定并实时刷新策略、写审计 |
| `DELETE` | `/v1/admin/access/role-bindings`          | `access.manage`；移除绑定；启动配置及本人超级管理员受保护    |

正式登录使用飞书 OAuth 2.0：授权请求包含单次 `state` 和 S256 PKCE，Control API 按飞书官方实现将 `authen/v1/authorize` 与 `authen/v2/oauth/token` 配对交换授权码，再通过用户信息接口取得当前应用下的 `open_id`。`open_id` 只作为 P5 RBAC 的用户主体；飞书登录成功并不自动获得管理权限。飞书 `user_access_token` 用完即丢弃，浏览器只接收平台自己的 `HttpOnly + SameSite=Lax` 会话 Cookie。

管理台只显示飞书企业登录，不提供密码、本机 Bootstrap 或手工 Open ID 登录。当前运行配置固定关闭 `ADMIN_LOCAL_BOOTSTRAP_ENABLED` 和 `ADMIN_MANUAL_IDENTITY_ENABLED`。普通成员与超级管理员是两个入口，但都经过同一飞书 OAuth 回调；超级管理员入口只接受已绑定 `administrator` 的飞书用户，不能把普通用户提升为管理员。

14 个页面的视觉规范、信息架构、交互状态机和管理接口清单见 [P6 管理台页面与交互规范](p6-admin-ui-spec.md)，日常管理流程见 [P6 管理中心操作说明书](p6-admin-operation-manual.md)。

## Trace 与告警

单任务 Trace 通过任务 ID 与 correlation ID 关联：

1. 飞书来源事件与回复目标；
2. 任务状态和有序 task event；
3. BullMQ attempt、Worker 和结果；
4. executor run 与统一 executor event；
5. 工具、错误码、错误消息、审批和审计事件。

当前自动评估以下告警：

- 等待队列达到阈值；
- Feishu Gateway 或 Windows Worker 离线/降级；
- 存在失败任务；
- Codex CLI 或 API Agent 模型执行失败；
- Token 预算达到告警比例或超过上限。

告警确认不会掩盖仍然存在的故障；后续快照持续更新 `last_seen_at`，故障消失后自动转为 `resolved`。

## 风险确认

| 操作 | 风险 | P6 行为                                  |
| ---- | ---- | ---------------------------------------- |
| 取消 | 中   | 精确确认后调用任务协调器并记录两阶段审计 |
| 重试 | 高   | 登记为 `pending_approval`                |
| 清理 | 高   | 登记为 `pending_approval`                |
| 重启 | 严重 | 登记为 `pending_approval`                |
| 回滚 | 严重 | 登记为 `pending_approval`                |

确认文本格式为 `确认<中文操作>:<目标 ID>`，必须完全匹配。管理台不会因为按钮点击直接执行高风险基础设施操作。

## 数据库

`0005_p6_operations.sql` 新增：

- `service_instances`：服务实例与心跳；
- `operational_alerts`：开放、已确认、已恢复告警；
- `admin_operations`：运维申请、状态和结果；
- `platform_releases`：版本与回滚元数据；
- `platform_backups`：备份、校验与恢复演练元数据；
- `platform_config_versions`：只保存安全配置摘要，不保存 Secret 值。

## 配置

```dotenv
FEISHU_OAUTH_ENABLED=false
FEISHU_OAUTH_REDIRECT_URI=http://127.0.0.1:5173/v1/admin/auth/feishu/callback
FEISHU_OAUTH_FRONTEND_URL=http://127.0.0.1:5173/
FEISHU_OAUTH_SCOPES=
FEISHU_OAUTH_SESSION_TTL_MS=28800000
FEISHU_OAUTH_REQUEST_TIMEOUT_MS=10000
ADMIN_LOCAL_BOOTSTRAP_ENABLED=false
ADMIN_MANUAL_IDENTITY_ENABLED=false
ADMIN_ALERT_QUEUE_WAITING_THRESHOLD=20
ADMIN_ALERT_BUDGET_PERCENT_THRESHOLD=80
ADMIN_SERVICE_PROBE_TIMEOUT_MS=2500
```

`FEISHU_OAUTH_SCOPES` 默认为空，因为登录只调用不要求额外 API 权限的用户信息接口，也不申请 `offline_access`。App Secret 继续通过 Windows Credential Manager 引用解析，不写入仓库。`ADMIN_LOCAL_BOOTSTRAP_ENABLED` 和 `ADMIN_MANUAL_IDENTITY_ENABLED` 在生产环境必须保持 `false`。三个阈值配置均要求正整数；无效值使用安全默认值。配置中心只显示是否配置，不显示阈值实际值。

## 验收命令

```powershell
pnpm db:migrate
pnpm --filter @feishu-agent/database run verify:p6
pnpm --filter @feishu-agent/control-api run verify:p6
pnpm --filter @feishu-agent/database run verify:p5
pnpm --filter @feishu-agent/windows-worker run verify:p4-integrations
pnpm check
pnpm audit --prod --audit-level high
```

Control API 的 `verify:p6` 会创建一条来源为飞书的合成任务，用批准范围外的 GitLab 资源稳定触发只读越权失败，然后通过真实 API 与 PostgreSQL 验证三服务 readiness、普通/超级管理员 OAuth 入口、仅飞书登录门禁、来源事件、任务、执行器、工具事件和错误关联。脚本不会创建绕过登录的管理会话，结束时清理合成任务和会话，也不输出管理员 ID 或任何凭据。受保护快照、角色页面和管理写操作继续由自动化契约测试与真实飞书登录验收覆盖。

## 本机访问

普通成员入口：`http://127.0.0.1:5173/#overview`。

超级管理员入口：`http://127.0.0.1:5173/#super-admin-login`。

两个入口使用同一个回调。点击飞书登录前，需要在当前企业自建应用的 **安全设置 → 重定向 URL** 中加入以下精确地址，并创建版本、发布生效：

```text
http://127.0.0.1:5173/v1/admin/auth/feishu/callback
```

飞书授权完成后回到管理台，Control API 根据登录用户 `open_id` 执行 RBAC。当前项目复用“机器人”应用，因此已有管理员 Open ID 绑定可以直接复用；如果以后拆分独立登录应用，由于不同应用的 `open_id` 不同，必须重新建立角色绑定或改为经过校验的 `union_id` 映射。

2026-08-22 真实验收：回调 URL 发布生效；修复 OAuth v3 Token 端点返回 `20049` 的协议版本错配后，用户通过飞书授权成功建立 HttpOnly 平台会话，经管理员 RBAC 校验后进入管理台 `#alerts`。同期服务端日志无 OAuth 错误和 HTTP 401。该结果同时验证了授权码回调、用户信息读取、会话恢复和受保护管理页面访问链路。

生产环境必须继续遵循架构基线：管理台仅在公司内网/VPN 提供 HTTPS，公网入站为零。P6 没有改变网络边界或混合部署拓扑，因此无需调整 `network-topology-v3` 和 `technical-architecture-v2`。
