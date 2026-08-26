#!/usr/bin/env bash
set -euo pipefail

environment_file="${1:-/opt/feishu-agent/production.env}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_directory="/var/lib/feishu-agent/releases"
previous_file="${state_directory}/previous"
active_file="${state_directory}/active"
if [[ ! -s ${previous_file} ]]; then echo 'No previous Linux release is recorded.' >&2; exit 1; fi
previous="$(tr -d '\r\n' < "${previous_file}")"
if [[ ! ${previous} =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]]; then echo 'Previous release state is invalid.' >&2; exit 1; fi
export PLATFORM_VERSION="${previous}"
compose=(docker compose --env-file "${environment_file}" -f "${root}/deploy/docker/compose.prod.yml")

"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps control-api edge
"${compose[@]}" exec -T control-api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

python3 - "${environment_file}" "${previous}" <<'PY'
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

if [[ -f ${active_file} ]]; then cp -f "${active_file}" "${state_directory}/rolled-back-from"; fi
printf '%s\n' "${previous}" > "${active_file}"
echo "Rolled back application images to ${previous}. Database migrations remain forward-only and must be backward compatible."
