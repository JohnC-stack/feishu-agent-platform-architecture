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
if [[ -f ${active_file} ]]; then cp -f "${active_file}" "${state_directory}/rolled-back-from"; fi
printf '%s\n' "${previous}" > "${active_file}"
echo "Rolled back application images to ${previous}. Database migrations remain forward-only and must be backward compatible."
