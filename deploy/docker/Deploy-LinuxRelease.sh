#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: Deploy-LinuxRelease.sh <version> [production.env]'
}

version="${1:-}"
environment_file="${2:-/opt/feishu-agent/production.env}"
if [[ -z ${version} || ! ${version} =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]]; then usage >&2; exit 2; fi
if [[ ! -f ${environment_file} ]]; then echo "Missing environment file: ${environment_file}" >&2; exit 1; fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${root}/deploy/docker/compose.prod.yml"
state_directory="/var/lib/feishu-agent/releases"
mkdir -p "${state_directory}"
export PLATFORM_VERSION="${version}"

# Windows-created source archives do not preserve POSIX executable bits.
# Normalize only repository-owned deployment scripts before invoking child scripts.
find "${root}/deploy" -type f -name '*.sh' -exec chmod 0755 {} +

compose=(docker compose --env-file "${environment_file}" -f "${compose_file}")
"${compose[@]}" config --quiet
"${compose[@]}" build control-api edge
"${compose[@]}" up -d postgres redis
"${compose[@]}" run --rm migrate
"${compose[@]}" --profile canary up -d --no-deps control-api-canary

canary_container="$("${compose[@]}" --profile canary ps -q control-api-canary)"
if [[ -z ${canary_container} ]]; then echo 'Canary container was not created.' >&2; exit 1; fi
for _ in {1..24}; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${canary_container}")"
  [[ ${status} == healthy ]] && break
  [[ ${status} == unhealthy || ${status} == exited ]] && { docker logs --tail 100 "${canary_container}" >&2; exit 1; }
  sleep 5
done
if [[ $(docker inspect --format '{{.State.Health.Status}}' "${canary_container}") != healthy ]]; then
  echo 'Canary did not become healthy in time.' >&2
  exit 1
fi

active_file="${state_directory}/active"
previous_file="${state_directory}/previous"
if [[ -f ${active_file} ]]; then cp -f "${active_file}" "${previous_file}"; fi
"${compose[@]}" up -d --no-deps control-api edge
"${compose[@]}" exec -T control-api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
"${compose[@]}" --profile canary rm -sf control-api-canary

# Persist the accepted image tag so the systemd-managed compose stack uses the
# same release after a host restart. Preserve owner and mode, and replace the
# file atomically only after all deployment health gates have passed.
python3 - "${environment_file}" "${version}" <<'PY'
import os
from pathlib import Path
import sys
import tempfile

path = Path(sys.argv[1])
version = sys.argv[2]
stat = path.stat()
lines = path.read_text(encoding='utf-8').splitlines()
updated = []
found = False
for line in lines:
    if line.startswith('PLATFORM_VERSION='):
        if found:
            raise SystemExit('production.env contains duplicate PLATFORM_VERSION entries')
        updated.append(f'PLATFORM_VERSION={version}')
        found = True
    else:
        updated.append(line)
if not found:
    updated.append(f'PLATFORM_VERSION={version}')

handle, temporary_name = tempfile.mkstemp(prefix='.production.env.', dir=str(path.parent))
try:
    with os.fdopen(handle, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write('\n'.join(updated) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary_name, stat.st_mode)
    os.chown(temporary_name, stat.st_uid, stat.st_gid)
    os.replace(temporary_name, path)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY

printf '%s\n' "${version}" > "${active_file}"
systemctl enable feishu-agent-compose.service

echo "Release ${version} passed migration, canary, and active health gates."
