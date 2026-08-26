# Windows 执行面部署

P7 将 Feishu Gateway 和 Windows Worker 作为原生 Windows Service 运行。Docker Desktop 不属于生产依赖。服务由固定版本和 SHA256 的 WinSW 托管，应用发布目录只增不改，通过 `current` 目录联接完成原子切换。

2026-08-26 实机基线：活动版本 `0.7.0-p7rc1`；两个服务均为 `LocalService / Automatic / Running`，整机重启后自动恢复；Windows 防火墙只允许 `192.168.100.10` 访问 3100/3200。`p7rc1 → p7rc2 → p7rc1` 的正式升级/双服务健康/回滚演练已通过，mTLS 证书指纹保持不变。日常操作和故障定位见 [`docs/p7-hybrid-deployment-operation-manual.md`](../../docs/p7-hybrid-deployment-operation-manual.md)。

## 目录与权限

默认目录：

- `C:\Program Files\FeishuAgent\releases\<version>`：不可变发布包；
- `C:\Program Files\FeishuAgent\current`：当前 Gateway/Worker 目录联接；
- `C:\ProgramData\FeishuAgent\config`：不含明文密钥的环境配置；
- `C:\ProgramData\FeishuAgent\secrets`：仅管理员、SYSTEM 和服务账号可读；
- `C:\ProgramData\FeishuAgent\tls`：内部 CA、服务端证书和私钥；
- `C:\ProgramData\FeishuAgent\logs|state|tasks`：日志、发布状态和任务目录。

当前工作站为降低系统盘占用，安装时覆盖为：

- `D:\FeishuAgent\program`：不可变发布包、当前版本联接和 WinSW 服务包装器；
- `D:\FeishuAgent\data`：配置、密钥、证书、日志、状态和任务目录；
- `D:\FeishuAgent\backups`：迁移与升级前备份。

安装脚本默认以 `LocalService` 完成最小权限启动。飞书、GitLab 和 Confluence 的生产凭据统一放在 `D:\FeishuAgent\data\secrets`，通过 `filecred://` 启动时解析；目录只允许管理员、SYSTEM 和 LocalService 访问。Confluence 使用内置只读会话客户端，不依赖个人 Python、CLI 或 DPAPI 配置。首次迁移企业凭据时运行：

```powershell
.\deploy\windows\Initialize-EnterpriseServiceCredentials.ps1
```

脚本只在本机安全窗口请求 Confluence 密码，先真实验证 GitLab 和 Confluence 身份，再写受 ACL 保护且不带换行的凭据文件；不会把密码、Token 或 Cookie写入聊天、控制台或 Git。`Set-WindowsServiceAccount.ps1` 仅保留给公司明确批准的专用域服务账号场景，不要为了复用个人凭据把 Gateway 或 Worker 改成个人账号。

## 发布流程

在非管理员终端构建并验签：

```powershell
.\deploy\windows\Build-WindowsRelease.ps1 -Version 0.7.0
.\deploy\windows\Test-WindowsRelease.ps1 -ReleasePath .\.runtime\p7-windows-releases\0.7.0
.\deploy\windows\Download-WinSW.ps1
.\deploy\windows\New-WindowsServiceStage.ps1
```

构建脚本默认拒绝包含未提交修改的工作区，避免发布清单错误地把旧 `HEAD` 标成实际源代码。仅用于本机验收的临时候选可显式使用 `-AllowDirty`；清单会记录 `workingTreeDirty=true` 和差异 SHA256，正式提交与推送后必须重新构建干净发布包。

staging 会从项目根 `.env` 读取企业系统地址、资源白名单和凭据引用，拒绝 GitLab 明文 Token，并把飞书、GitLab、Confluence Secret 保持为 `filecred://`。生成结果中的 `WorkerIntegrations` 三项都必须为 `True`、`RequiresUserProfileServiceAccount` 必须为 `False`，且不得存在 `replace-with-` 占位符。

管理员安装时只传入已受 ACL 保护的 staging 目录。脚本仅复制明确列出的证书与凭据文件，导入内部 CA 和不可导出的 Windows mTLS 客户端证书，并为三个固定内部域名写入精确 hosts 映射：

```powershell
.\deploy\windows\Install-WindowsServices.ps1 `
  -ReleasePath .\.runtime\p7-windows-releases\0.7.0 `
  -GatewayEnvironmentFile .\.runtime\p7-windows-stage\config\gateway.env `
  -WorkerEnvironmentFile .\.runtime\p7-windows-stage\config\worker.env `
  -TlsSourceDirectory .\.runtime\p7-windows-stage\tls `
  -SecretsSourceDirectory .\.runtime\p7-windows-stage\secrets `
  -LinuxVmAddress 192.168.100.10 `
  -InstallRoot D:\FeishuAgent\program `
  -DataRoot D:\FeishuAgent\data
```

脚本只为 Linux VM 的单一 IP 放行 TCP 3100/3200，且应用层强制客户端证书。不得把远端地址改成 `Any`，不得为服务创建公网端口转发。

## Hyper-V Linux VM

先生成仅保存在 `.runtime` 的 SSH 密钥、随机应急口令和 NoCloud `cidata` ISO，再将它与已校验的 Ubuntu Server ISO 一起附加到固定 MAC 的第 2 代 VM：

```powershell
.\deploy\windows\New-UbuntuAutoinstallSeed.ps1
.\deploy\windows\New-ProductionLinuxVm.ps1 `
  -InstallerIsoPath .\.runtime\p7-hyperv\ubuntu-24.04.4-live-server-amd64.iso `
  -AutoinstallSeedIsoPath .\.runtime\p7-hyperv\autoinstall\seed.iso
```

VM 固定使用 `192.168.100.10/24`，宿主内部地址为 `192.168.100.1`；SSH 只允许宿主地址进入且只接受生成的公钥。应急口令和私钥受 NTFS ACL 保护，不得提交到 Git。Ubuntu 安装器从 `cidata` 读取配置；首次从安装 ISO 启动时仍需在启动参数中确认 `autoinstall`，随后安装、静态网络、SSH 与基础防火墙均自动完成。

升级、健康检查和回滚：

```powershell
.\deploy\windows\Switch-WindowsRelease.ps1 -ReleasePath .\.runtime\p7-windows-releases\0.7.1 -ClientCertificateThumbprint <thumbprint>
.\deploy\windows\Test-WindowsServices.ps1 -ClientCertificateThumbprint <thumbprint>
.\deploy\windows\Rollback-WindowsRelease.ps1 -ClientCertificateThumbprint <thumbprint>
```

新版本健康检查失败时，切换脚本会在同一次操作中恢复上一版本。卸载默认保留 `ProgramData` 中的密钥、证书、日志和状态；只有显式指定 `-RemoveProgramFiles` 才删除程序文件。

发布复制脚本会保留并重定向发布包内部的 junction/symlink，拒绝任何指向发布根目录之外的链接。切换脚本兼容 Windows PowerShell 5.1 与 PowerShell 7，并在写入活动状态时保留 mTLS 证书指纹。

## 凭据约束

生产环境文件应使用 `filecred://D:/FeishuAgent/data/secrets/<name>`。`wincred://<target>` 只用于交互式开发或一次性迁移，因为 LocalService 无法读取个人凭据库。Worker 会在创建企业集成客户端前解析引用；解析失败会阻止服务启动，避免把引用字符串误当成凭据继续运行。密钥文件不得进入 Git、发布包或 WinSW XML。内部 mTLS 私钥使用绝对路径，并由 NTFS ACL 限制为管理员、SYSTEM 和服务账号可读。
