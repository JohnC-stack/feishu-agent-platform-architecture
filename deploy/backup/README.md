# 备份、恢复与演练

`Backup-LinuxControlPlane.sh` 生成 PostgreSQL custom dump、Redis RDB、非敏感配置、发布状态、TLS 材料和凭据文件，然后在临时目录内生成逐文件 SHA256，最后用 age 收件人公钥加密。未加密的临时文件会在退出时清理；备份目录只保留 `.tar.age`、归档哈希和不含密钥的报告。

```bash
sudo ./deploy/backup/Backup-LinuxControlPlane.sh \
  /opt/feishu-agent/production.env \
  age1... \
  /opt/feishu-agent/backups
```

`Restore-LinuxControlPlane.sh` 只接受空目标目录和不存在的 Compose 项目/卷，避免覆盖现有环境。它先验证加密归档与内部清单，再恢复到全新 PostgreSQL/Redis 卷并验证 migration 数量和 Redis PONG。
恢复演练默认使用隔离端口 `28443` 和 `26379`，避免与本机主栈的 `8443` 和 `16379` 冲突；需要并行执行多次演练时，可通过 `RESTORE_EDGE_PORT` 和 `RESTORE_REDIS_PORT` 另行指定。

```bash
sudo ./deploy/backup/Run-RecoveryDrill.sh \
  /mnt/off-host/feishu-agent-20260824T000000Z.tar.age \
  /secure/age-identity.txt
```

备份成功只代表文件已生成；P7 阶段出口必须保留 `recovery-drill-report.json`，且异机或独立项目恢复结果为 `passed`。age 私钥必须离线保管，不能与备份归档存放在同一主机。
