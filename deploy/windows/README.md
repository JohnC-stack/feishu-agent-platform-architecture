# Windows 执行面部署

P0 仅保留目录和部署边界。P7 将在这里交付：

- Feishu Gateway 与 Windows Worker 的 WinSW 配置。
- 安装、升级、健康检查、回滚和卸载 PowerShell 脚本。
- 最小权限服务账号、工作目录 ACL 与 Windows 防火墙规则。
- 凭据写入 Windows Credential Manager 或企业密钥系统的操作说明。

生产部署脚本不得保存明文密钥，也不得自动放宽公网入站规则。
