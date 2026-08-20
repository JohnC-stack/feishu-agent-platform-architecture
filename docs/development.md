# 本地开发指南

## 1. 前置条件

- Windows 11 或 Windows Server 2022。
- Node.js 22–24。
- pnpm 10–11。
- Docker Engine 或 Docker Desktop，仅用于本地开发 PostgreSQL 和 Redis。
- Git。
- P3 Agent CLI 任务需要独立安装 Codex CLI，并完成本机安全登录。

生产 Windows Server 不使用 Docker Desktop；生产控制面部署在 Hyper-V Linux VM 中。

### Windows 首次环境准备

缺少环境时，先完成安装和版本验证，再执行项目命令。以下命令使用 winget 官方清单；启用 Windows 功能后需要重启：

```powershell
# 以管理员 PowerShell 启用 WSL2 必需功能，返回 3010 表示需要重启。
.\deploy\windows\Enable-LocalDevelopmentWsl.ps1

# 重启后安装 WSL 系统组件、Docker Desktop 和 Node.js LTS。
winget install --id 9P9TQF7MRM4R --source msstore --exact
winget install --id XP8CBJ40XLBWKX --source msstore --exact
winget install --id OpenJS.NodeJS.LTS --exact

# 在用户目录启用项目固定的 pnpm 版本。
New-Item -ItemType Directory -Force -Path "$env:APPDATA\npm" | Out-Null
corepack prepare pnpm@11.19.0 --activate
corepack enable --install-directory "$env:APPDATA\npm" pnpm
```

Docker Desktop 只用于 Windows 本地开发。首次启动前由使用者自行核对并接受适用的 Docker 许可条款；企业生产部署仍使用 Hyper-V Linux VM 中的 Docker Engine。

环境验收：

```powershell
wsl --version
wsl --status
node --version
pnpm --version
docker version
docker compose version
codex --version
codex login status
```

任何命令失败时先修复环境，不得跳过并继续后续阶段。

## 2. 首次启动

在 PowerShell 中执行：

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev:infra
pnpm db:migrate
pnpm check
pnpm dev
```

`pnpm dev` 会先构建共享包，再并行启动：

| 组件                    | 地址                    |
| ----------------------- | ----------------------- |
| 管理台                  | <http://127.0.0.1:5173> |
| Control API             | <http://127.0.0.1:3000> |
| Feishu Gateway 健康服务 | <http://127.0.0.1:3100> |
| Windows Worker 健康服务 | <http://127.0.0.1:3200> |

每个组件都提供 `/health/live` 和 `/health/ready`。管理台的健康文件由静态资源提供，其余三个服务使用统一健康协议。

## 3. 常用命令

```powershell
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm dev:infra:down
```

## 4. 配置与密钥

- `.env` 只用于本地开发，已被 Git 忽略。
- 仓库只提交无敏感信息的 `.env.example`。
- P1 飞书真实联调时，应用密钥由管理员本机录入，不进入聊天、Issue、提交或日志。
- API/ReAct 当前通过 `API_AGENT_ENABLED=false` 关闭。未来重新评审启用时，才在未跟踪的 `.env` 中填写 `OPENAI_API_KEY`；聊天、日志和 Git 中不得出现密钥。
- `AGENT_AUTHORIZED_WORKSPACE_ROOTS` 使用分号分隔允许 Agent CLI 访问的根目录；请求路径仍会由 Worker 再次做真实路径和越界校验。
- 健康接口和日志不得返回连接字符串、令牌、Cookie 或密码。

## 5. P0 验收

```powershell
pnpm install --frozen-lockfile
pnpm check
```

随后启动三个服务，确认六个动态健康接口返回 HTTP 200；启动管理台并确认两个静态健康路径可访问。Docker 不可用时，代码检查仍可完成，但数据库迁移与基础设施启动不能标记为已验证。

## 6. P3 执行器验收

```powershell
pnpm db:migrate
pnpm --filter @feishu-agent/database run verify:p3
pnpm --filter @feishu-agent/control-api run verify:p3
pnpm --filter @feishu-agent/windows-worker run verify:agent-cli
pnpm --filter @feishu-agent/control-api run verify:agent-pipeline

# 仅在重新启用 API 通道、设置 API_AGENT_ENABLED=true 且密钥已安全写入本机 .env 后执行：
pnpm --filter @feishu-agent/control-api run verify:api-pipeline
```

前三条真实验证分别覆盖 PostgreSQL 执行审计、DirectTool 完整调度链路和 Codex CLI JSONL/续接；`verify:agent-pipeline` 覆盖 Agent CLI 的 BullMQ、Windows Worker、工作区、数据库与清理完整链路。`API_AGENT_ENABLED=false` 时，Worker 不将 `api_agent` 列为活动执行器，也不把它加入 readiness；显式 API 请求会强制失败且不会静默回退。

未来只有在正式决定恢复该通道后，才执行真实计费 API 验收；保持关闭时无需调用外部 API。
