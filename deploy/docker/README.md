# Hyper-V Linux 控制面

生产控制面运行在独立 Hyper-V Linux VM 的 Docker Engine 中，不使用 WSL 或 Docker Desktop。VM 连接内部虚拟交换机并通过 NAT 访问外部网络；PostgreSQL 不映射端口，Prometheus/Grafana 不直接映射端口，只有内部地址上的 HTTPS 443 和 Redis TLS 6379 可见。

2026-08-26 实机基线：Ubuntu 24.04.4、`192.168.100.10/24`、活动版本 `0.7.0-p7rc1`；`feishu-agent-compose.service` 为 enabled/active，6 个生产容器可在 Windows 整机重启后自动恢复，Prometheus 的 Control API、Gateway、Worker 三个目标均为 `up`。`p7rc1 → p7rc2 → p7rc1` 的正式 migration、金丝雀、健康、任务链路和回滚演练已通过。日常操作和故障定位见 [`docs/p7-hybrid-deployment-operation-manual.md`](../../docs/p7-hybrid-deployment-operation-manual.md)。

推荐 VM 基线：Ubuntu Server 24.04 LTS、4 vCPU、8–16 GB RAM、120 GB 动态 VHDX、静态地址 `192.168.100.10/24`、Windows Host `192.168.100.1`。主机脚本会拒绝 WSL。

执行顺序：

1. Windows 管理员运行 `Enable-ProductionHyperV.ps1`，重启后用 `New-ProductionLinuxVm.ps1` 创建内部交换机、NAT 和 VM；
2. 在 VM 安装系统并设置静态 IP，把发布包解压到 `/opt/feishu-agent`，然后以 root 执行 `bash /opt/feishu-agent/deploy/docker/Install-LinuxHost.sh`；脚本会恢复 Windows 打包流程可能丢失的 `.sh` 可执行权限；
3. 由企业 CA 签发 edge、Redis、Gateway、Worker 和双向 TLS 客户端证书；`New-P7TestPki.ps1` 只用于 P7 演练，不得用于正式生产；
4. 把 `production.env.example` 复制为 `/opt/feishu-agent/production.env`，配置文件只保存非敏感值；
5. 把密钥放入 `/opt/feishu-agent/secrets`、证书放入 `/opt/feishu-agent/tls`，属组设为 `feishu-agent-secrets`，权限设为 `0440`；Compose 仅将该只读组加入实际使用 Secret 的容器；
6. 设置明确来源后运行 `Configure-LinuxFirewall.sh`；
7. 运行 `Deploy-LinuxRelease.sh <version>`。脚本依次执行配置校验、镜像构建、数据库迁移、无消费队列的 canary、健康检查和正式切换。

回滚只切回上一版本应用镜像；数据库 migration 必须保持向后兼容，禁止依赖自动降级 SQL。所有第三方镜像都固定版本和摘要。
