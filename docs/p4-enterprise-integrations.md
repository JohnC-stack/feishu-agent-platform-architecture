# P4 企业系统只读接入

## 范围与状态

P4 只实现读取能力，不包含评论、合并、编辑、创建或删除。所有调用同时受到任务级工具授权和资源精确白名单约束。

| 系统       | 读取范围                               | 自动化契约 | 真实联调 |
| ---------- | -------------------------------------- | ---------- | -------- |
| GitLab     | 项目、MR、差异、流水线、作业日志       | 已通过     | 已通过   |
| Confluence | 空间搜索、页面、附件元数据、评论       | 已通过     | 已通过   |
| 飞书       | 新版文档、多维表格、群组、用户基本信息 | 已通过     | 已通过   |

当前接入没有新增公网入站端口。Windows Worker 通过 HTTPS 访问飞书，通过公司 VPN 访问 Confluence；公司 GitLab 17.2.9 当前使用内网 HTTP `192.168.27.20:8000`。该 HTTP 链路只作为 P4 开发验收例外，生产前必须升级 HTTPS 或增加可信 TLS 反向代理。

## 确定性命令

以下命令使用 `DirectToolExecutor`，不会调用模型：

```text
/gitlab project <project-id-or-path>
/gitlab mr <project-id-or-path> <mr-iid>
/gitlab diffs <project-id-or-path> <mr-iid> [page] [per-page]
/gitlab pipeline <project-id-or-path> <pipeline-id>
/gitlab job <project-id-or-path> <job-id>

/confluence search <space-key> <text>
/confluence page <space-key> <page-id>
/confluence attachments <space-key> <page-id> [limit]
/confluence comments <space-key> <page-id> [limit]

/feishu document <document-id>
/feishu bitable <app-token>
/feishu chat <chat-id>
/feishu user <open-id-or-user-id>
```

Control API 只会为当前命令批准对应的单个读取工具：`gitlab.read`、`confluence.read` 或 `feishu.read`。Agent CLI 不继承这些工具授权。

## 配置

真实值只写入未跟踪的 `.env` 或后续企业密钥系统。

```dotenv
GITLAB_BASE_URL=https://gitlab.example.com
GITLAB_TOKEN=
GITLAB_ALLOWED_PROJECTS=group/project,123
GITLAB_VERIFY_PROJECT=group/project
GITLAB_VERIFY_MERGE_REQUEST_IID=
GITLAB_VERIFY_PIPELINE_ID=
GITLAB_VERIFY_JOB_ID=

CONFLUENCE_CLI_WRAPPER=C:/path/to/confluence.ps1
CONFLUENCE_ALLOWED_SPACE_KEYS=ENG,OPS
CONFLUENCE_ALLOWED_PAGE_IDS=123456,234567

FEISHU_ALLOWED_DOCUMENT_IDS=
FEISHU_ALLOWED_BITABLE_APP_TOKENS=
FEISHU_ALLOWED_CHAT_IDS=
FEISHU_ALLOWED_USER_IDS=
```

列表使用英文逗号分隔。空白名单一律拒绝，不会退化为“允许全部”。

### GitLab 服务账号

1. 使用独立机器人或项目访问令牌，不使用个人管理员令牌。
2. 令牌只申请 `read_api`；项目角色使用能读取目标数据的最低角色。
3. `GITLAB_ALLOWED_PROJECTS` 只填写批准的项目数字 ID 或完整路径。
4. 禁止在 URL 查询参数或仓库配置中保存令牌；客户端仅使用 `PRIVATE-TOKEN` 请求头。
5. 真实验收会调用令牌自检 API；令牌必须处于活动状态且 Scope 精确等于 `read_api`，包含任何额外 Scope 时 fail-closed。

### Confluence 服务账号

本机复用注册的公司 Confluence CLI、Windows DPAPI 保存凭据和 VPN，不在仓库保存密码。搜索命令由平台生成带空间约束的 CQL，不接受调用方传入任意原始 CQL；页面、附件和评论还必须命中页面 ID 白名单，并复核返回页面所属空间。

### 飞书应用

应用身份至少需要以下只读权限，并在创建新版本后发布生效：

- `docx:document:readonly`：读取新版文档。
- `bitable:app:readonly`：读取多维表格。
- `im:chat:readonly`：读取群组信息。
- `contact:contact.base:readonly`：以应用身份调用通讯录基础读取 API。
- `contact:user.base:readonly`：允许通讯录响应返回用户基本字段。

通讯录的 API 调用权限和字段权限必须同时开通；只有
`contact:user.base:readonly` 时，获取用户或用户列表会返回飞书错误
`99991672`。不申请手机号、邮箱、员工编号等额外字段权限。

仅开通 API 权限还不够：

- 文档和多维表格需要把应用添加为目标资源的协作者，再把资源 token 加入本机白名单。
- 通讯录需要把测试用户纳入应用的数据权限范围；新版控制台中的“部分成员”即精确测试范围。
- 群组需要机器人已加入，并把群 ID 加入白名单。

应用发布后运行 `pnpm --filter @feishu-agent/windows-worker run probe:p4-feishu`，只查看鉴权状态、错误码和资源 ID，不输出访问令牌。通讯录探针不指定根部门，以兼容只授权独立测试成员的最小数据范围。

## 安全与故障策略

- 只允许安全相对路径；HTTP 客户端锁定配置的 origin 和 API 路径前缀，禁止跨域重定向携带凭据。
- GitLab 项目、Confluence 空间/页面和飞书资源都使用精确白名单，未批准资源在发起网络请求前拒绝。
- 超时、HTTP `408/425/429/5xx`、飞书限流和畸形 JSON 使用有限指数退避；默认最多 3 次，不存在无限重试。
- 传输响应默认上限 1 MB；进入工具网关前再次按 20,000 字符截断。
- `Authorization`、Cookie、密码、App Secret、API Key、GitLab/飞书 Token 字段与常见字符串模式在返回前脱敏。
- 权限失败不可重试；限流、超时和依赖瞬时故障保留可重试分类。

## 验收命令

```powershell
pnpm exec vitest run packages/integrations/src
pnpm exec vitest run apps/windows-worker/src apps/control-api/src/runtime-policy.test.ts
pnpm --filter @feishu-agent/windows-worker run verify:p4-integrations
pnpm check
pnpm audit --prod --audit-level high
```

真实验证程序只输出系统、操作、成功状态、截断状态和错误码，不输出页面正文、作业日志、令牌或 Secret。

## P4 关闭记录

- GitLab：仅 `read_api` 令牌、11 个项目、MR、分页差异和流水线真实读取通过；所有批准项目当前均无 GitLab Job，因此日志实读不适用，契约、截断和脱敏测试通过。
- Confluence：页面、附件元数据和评论真实读取通过。
- 飞书：新版文档、多维表格、测试群和两名精确白名单用户真实读取通过。
- 三系统统一验收共 23 项全部通过；全仓 31 个测试文件、86 个测试、全部构建及生产依赖审计通过。
