#!/usr/bin/env bash
set -euo pipefail

environment_file="${1:-/opt/feishu-agent/production.env}"
age_recipient="${2:-}"
output_directory="${3:-/opt/feishu-agent/backups}"
if [[ ! -f ${environment_file} ]]; then echo "Missing environment file: ${environment_file}" >&2; exit 1; fi
if [[ -z ${age_recipient} ]]; then echo 'An age recipient is required.' >&2; exit 2; fi
for command in docker age tar sha256sum; do command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }; done

set -a
# shellcheck disable=SC1090
source "${environment_file}"
set +a
: "${SECRETS_DIR:?SECRETS_DIR is required}"
: "${TLS_DIR:?TLS_DIR is required}"
: "${POSTGRES_USER:=feishu_agent}"
: "${POSTGRES_DB:=feishu_agent}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose=(docker compose --env-file "${environment_file}" -f "${root}/deploy/docker/compose.prod.yml")
"${compose[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null

mkdir -p "${output_directory}"
chmod 700 "${output_directory}"
staging="$(mktemp -d)"
cleanup() {
  find "${staging}" -type f -exec shred -u {} + 2>/dev/null || true
  rm -rf -- "${staging}"
}
trap cleanup EXIT
mkdir -p "${staging}/payload"

"${compose[@]}" exec -T postgres pg_dump --format=custom --no-owner --no-privileges -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" > "${staging}/payload/postgres.dump"
redis_container="$("${compose[@]}" ps -q redis)"
if [[ -z ${redis_container} ]]; then echo 'Redis container is not running.' >&2; exit 1; fi
"${compose[@]}" exec -T redis sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" redis-cli --tls --cacert /run/secrets/internal-ca --cert /run/secrets/linux-client-cert --key /run/secrets/linux-client-key --rdb /tmp/feishu-agent-backup.rdb >/dev/null'
docker cp "${redis_container}:/tmp/feishu-agent-backup.rdb" "${staging}/payload/redis.rdb" >/dev/null
"${compose[@]}" exec -T redis rm -f /tmp/feishu-agent-backup.rdb

cp -a "${SECRETS_DIR}" "${staging}/payload/secrets"
cp -a "${TLS_DIR}" "${staging}/payload/tls"
cp -a "${environment_file}" "${staging}/payload/production.env"
cp -a "${root}/deploy/docker" "${staging}/payload/deploy-docker"
if [[ -d /var/lib/feishu-agent/releases ]]; then cp -a /var/lib/feishu-agent/releases "${staging}/payload/releases"; fi
"${compose[@]}" config > "${staging}/payload/compose.rendered.yml"

(
  cd "${staging}/payload"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${output_directory}/feishu-agent-${timestamp}.tar.age"
tar -C "${staging}/payload" -cf - . | age -r "${age_recipient}" -o "${archive}"
archive_hash="$(sha256sum "${archive}" | awk '{print $1}')"
printf '%s  %s\n' "${archive_hash}" "$(basename "${archive}")" > "${archive}.sha256"
chmod 600 "${archive}" "${archive}.sha256"
printf '{"createdAt":"%s","archive":"%s","encrypted":true,"databaseDump":true,"redisSnapshot":true,"configuration":true}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "${archive}")" > "${archive}.report.json"
chmod 600 "${archive}.report.json"

echo "Encrypted backup created: ${archive}"
