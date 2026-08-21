# P5 治理与审批

## 范围与阶段门禁

P5 在 P4 只读工具之上增加统一治理层，包括 RBAC、写操作审批、幂等、预算、审计和凭据引用。未授权请求在进入 BullMQ 或企业系统前拒绝；高风险写操作在审批前保持 `pending_approval`，审批成功后由数据库原子声明保证最多执行一次。

当前实现、本地/运行态验收和测试群真实审批卡片点击均已完成。飞书 WSS `card.action.trigger` 回传、重复投递去重、职责分离、数据库决策审计和共享卡片终态更新全部通过。代码尚未提交和推送；远端 CI 与 Security 成功后正式关闭 P5。

## 角色与权限

| 角色            | 能力                                                             |
| --------------- | ---------------------------------------------------------------- |
| `reader`        | 查看并调用平台健康、GitLab、Confluence、飞书批准范围内的只读工具 |
| `operator`      | 查看并申请执行受治理的 Agent CLI 工作区操作                      |
| `approver`      | 批准、拒绝和撤销审批；不得审批自己申请的操作                     |
| `auditor`       | 查看和导出已脱敏审计事件                                         |
| `administrator` | 管理全部治理能力；仍受审批状态机、幂等和审计约束                 |

角色绑定同时支持用户和群组。能力接口只返回当前身份可见的工具，未知身份返回空工具集合。Control API 仅绑定回环地址；飞书网关从 WSS 已鉴权回调中取得实际操作人，再调用本机 Control API。

## 审批与幂等

高风险操作流程：

1. Control API 校验请求人对工具及资源范围的授权。
2. PostgreSQL 以幂等键和规范化请求哈希创建受治理操作。
3. 同一幂等键、同一载荷返回原记录；同一键但载荷变化返回冲突。
4. Control API 经回环接口调用飞书网关，把红色审批卡片发送至请求群。
5. 审批人点击批准或拒绝，飞书通过现有 WSS 长连接发送 `card.action.trigger`。
6. 飞书网关对回调去重，Control API 校验审批角色与职责分离，数据库锁定审批记录并转换状态。
7. 飞书网关在 WSS 回调响应中立即返回无按钮终态卡，并在响应后异步调用消息更新 API 兜底；共享卡对群内所有接收者生效。
8. 只有 `approved` 操作可以原子声明执行；重复声明不会再次执行。

审批支持 `pending`、`approved`、`rejected`、`expired` 和 `revoked`。重复决策、过期后批准、自审批和审批人越权全部 fail-closed。

终态卡保留原卡中的工具、资源、风险、申请人和过期时间，移除批准/拒绝按钮，并追加中文审批状态、中文操作状态和审批人。待审批卡与终态卡的过期时间均按北京时间输出为 `yyyy-MM-dd HH:mm:ss`。

## 预算与审计

预算按用户每日、群组每日、单任务和模型每日四个层级同时生效。Control API 在任务入队前以 PostgreSQL advisory lock 原子预留 Token 和成本；任一层级超限返回 HTTP `429`，不会创建或排队任务。

审计记录包含关联 ID、执行人、动作、资源、结果、时间和角色决策信息。导出仅限审计员或管理员，递归脱敏令牌、Secret、Cookie、密码和常见凭据字段。每条记录保存到期时间，可按保留策略清理。

## 凭据

`.env` 不再保存飞书 App Secret 和 GitLab Token 明文，只保存引用：

```dotenv
FEISHU_APP_SECRET=wincred://FeishuAgent/Feishu/AppSecret
GITLAB_TOKEN=wincred://FeishuAgent/GitLab/ReadApiToken
CREDENTIAL_TARGET_PREFIXES=FeishuAgent/
```

Windows Worker 和飞书网关在启动时解析允许前缀下的 Windows Credential Manager 引用。受保护凭据对象不能通过字符串转换或 JSON 序列化泄露。仓库同时提供企业密钥管理器适配接口；数据库只保存提供方、目标名、状态和时间等元数据。

## 配置

```dotenv
GOVERNANCE_ADMIN_USER_IDS=
GOVERNANCE_READER_USER_IDS=
GOVERNANCE_OPERATOR_USER_IDS=
GOVERNANCE_APPROVER_USER_IDS=
GOVERNANCE_AUDITOR_USER_IDS=
GOVERNANCE_READER_GROUP_IDS=
GOVERNANCE_OPERATOR_GROUP_IDS=
GOVERNANCE_APPROVER_GROUP_IDS=
GOVERNANCE_AUDITOR_GROUP_IDS=

GOVERNANCE_APPROVAL_TTL_SECONDS=3600
GOVERNANCE_AUDIT_RETENTION_DAYS=365
GOVERNANCE_USER_DAILY_TOKEN_LIMIT=2000000
GOVERNANCE_USER_DAILY_COST_MICROS=100000000
GOVERNANCE_GROUP_DAILY_TOKEN_LIMIT=10000000
GOVERNANCE_GROUP_DAILY_COST_MICROS=500000000
GOVERNANCE_TASK_TOKEN_LIMIT=200000
GOVERNANCE_TASK_COST_MICROS=20000000
GOVERNANCE_MODEL_DAILY_TOKEN_LIMIT=20000000
GOVERNANCE_MODEL_DAILY_COST_MICROS=1000000000

CONTROL_API_INTERNAL_URL=http://127.0.0.1:3000
FEISHU_GATEWAY_INTERNAL_URL=http://127.0.0.1:3100
```

至少配置一名启动管理员。正式环境应使用两个不同账号分别绑定 `operator` 与 `approver`，并保持最小权限。

## Control API

| 方法   | 路径                                             | 说明                     |
| ------ | ------------------------------------------------ | ------------------------ |
| `GET`  | `/v1/governance/capabilities`                    | 返回当前身份可见工具能力 |
| `POST` | `/v1/governance/operations`                      | 创建受治理写操作及审批   |
| `POST` | `/v1/governance/approvals/:approvalId/decisions` | 批准、拒绝或撤销         |
| `GET`  | `/v1/governance/audit/export`                    | 导出已脱敏审计事件       |

飞书网关提供仅回环可达的 `/internal/approvals/cards` 用于发送审批卡片，以及 `/approvals/status` 用于查看真实回调处理计数。

## 数据库

`0004_p5_governance.sql` 新增角色、角色绑定、受治理操作、预算限制、预算使用和凭据引用，并扩展审批与审计表。迁移通过 migration 登记保证幂等。

## 验收命令

```powershell
pnpm --filter @feishu-agent/database run verify:p5
pnpm --filter @feishu-agent/database run verify:p5-live
pnpm --filter @feishu-agent/credentials run verify:windows
pnpm --filter @feishu-agent/windows-worker run verify:p4-integrations
pnpm check
pnpm audit --prod --audit-level high
```

数据库验收覆盖持久化 RBAC、未授权隐藏、审批门禁、职责分离、幂等冲突、单次执行、拒绝、过期、撤销、分层预算、脱敏审计和凭据仅引用。Windows 凭据验收只创建并删除一个合成测试凭据，不读取或输出真实 Secret。

## 当前验收证据

- `0004_p5_governance.sql` 已应用；12 项真实 PostgreSQL 治理检查全部为 `true`。
- Windows Credential Manager 合成写入、读取、序列化保护、前缀限制和清理全部通过。
- P4 GitLab、Confluence、飞书共 23 项真实只读回归全部通过。
- 运行态角色分离、未知身份零工具、未授权审批 HTTP `403`、重复决策/幂等冲突 HTTP `409`、已授权任务成功和脱敏审计导出均通过。
- 飞书 WSS、Redis、PostgreSQL、BullMQ 和 Windows Worker readiness 全部为 `ok`。
- 初次真实界面验收发现消息更新 API 成功不代表客户端已刷新；修复为 WSS 回调立即返回终态卡、响应后异步更新兜底，并按单卡维度保存幂等终态。
- 修复后连续两张真实审批卡均单次批准成功且失败为 0；用户确认样式切换、按钮消失、原内容保留和状态中文化。两次对应数据库检查均为 `approved`，职责分离、决策时间、版本推进和审批审计事件均为 `true`。
- 待审批卡和终态卡的北京时间格式 `yyyy-MM-dd HH:mm:ss` 已由自动化测试覆盖。
- `pnpm check` 通过：37 个测试文件、106 个测试及全部构建成功。
- `pnpm audit --prod --audit-level high` 无已知漏洞；`.env` 未跟踪且差异中未发现疑似明文凭据。
