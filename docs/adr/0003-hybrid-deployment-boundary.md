# ADR-0003：Windows 执行面与 Linux 控制面分离

- 状态：已接受
- 日期：2026-08-20

## 决策

Feishu Gateway、Windows Worker、本机工作区和 Agent CLI 运行在 Windows 原生服务中；管理台、Control API、Redis、PostgreSQL 与可观测性组件运行在 Hyper-V Linux VM 的 Docker 控制面中。

## 原因

- Windows 组件需要使用公司 VPN、Windows 凭据、路径、Git 和本地 CLI。
- 数据与 Web 控制面更适合通过 Linux 容器实现升级、备份和迁移。
- Windows Server 生产环境不依赖 Docker Desktop。

## 后果

- 两个执行面之间只开放必要内部端口，并在 P7 引入 mTLS 服务身份。
- 管理台只允许内网或 VPN 访问，不配置公网入站。
- 高风险或不可信任务不能只依赖普通进程隔离，必须进入 Hyper-V 强隔离环境。
