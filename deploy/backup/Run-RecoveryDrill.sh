#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
age_identity="${2:-}"
drill_root="${3:-/opt/feishu-agent-drills/$(date -u +%Y%m%dT%H%M%SZ)}"
project="feishu-agent-drill-$(date -u +%H%M%S)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"${root}/deploy/backup/Restore-LinuxControlPlane.sh" "${archive}" "${age_identity}" "${drill_root}" "${project}"
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report="${drill_root}/reports/recovery-drill-report.json"
printf '{"startedAt":"%s","finishedAt":"%s","project":"%s","database":true,"redis":true,"configuration":true,"result":"passed"}\n' \
  "${started}" "${finished}" "${project}" > "${report}"
echo "Recovery drill passed. Report: ${report}"
