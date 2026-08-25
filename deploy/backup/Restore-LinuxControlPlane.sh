#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
age_identity="${2:-}"
target_root="${3:-}"
target_project="${4:-}"
if [[ ! -f ${archive} || ! -f ${age_identity} ]]; then echo 'Backup archive and age identity are required.' >&2; exit 2; fi
if [[ -z ${target_root} || ${target_root} == '/' || -z ${target_project} || ! ${target_project} =~ ^[a-z0-9][a-z0-9_-]{2,40}$ ]]; then
  echo 'A dedicated non-root target directory and safe target project name are required.' >&2
  exit 2
fi
target_root="$(realpath -m "${target_root}")"
if [[ -e ${target_root} ]] && [[ -n $(find "${target_root}" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo "Restore target is not empty: ${target_root}" >&2
  exit 1
fi
for command in docker age tar sha256sum; do command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }; done
if [[ -f ${archive}.sha256 ]]; then
  expected_hash="$(awk 'NR == 1 { print $1 }' "${archive}.sha256")"
  actual_hash="$(sha256sum "${archive}" | awk '{ print $1 }')"
  if [[ ! ${expected_hash} =~ ^[0-9a-fA-F]{64}$ || ${actual_hash} != "${expected_hash,,}" ]]; then
    echo 'Encrypted backup checksum verification failed.' >&2
    exit 1
  fi
fi

staging="$(mktemp -d)"
redis_seed_container=''
cleanup() {
  if [[ -n ${redis_seed_container} ]]; then docker rm -f "${redis_seed_container}" >/dev/null 2>&1 || true; fi
  rm -rf -- "${staging}"
}
trap cleanup EXIT
age -d -i "${age_identity}" "${archive}" | tar -C "${staging}" -xf -
(
  cd "${staging}"
  sha256sum -c SHA256SUMS
)

mkdir -p "${target_root}/secrets" "${target_root}/tls" "${target_root}/reports"
cp -a "${staging}/secrets/." "${target_root}/secrets/"
cp -a "${staging}/tls/." "${target_root}/tls/"
cp -a "${staging}/production.env" "${target_root}/production.env"
chmod 700 "${target_root}" "${target_root}/secrets" "${target_root}/tls"
chmod 600 "${target_root}/secrets/"* "${target_root}/tls/"*-key.pem 2>/dev/null || true
cat >> "${target_root}/production.env" <<EOF
COMPOSE_PROJECT_NAME=${target_project}
SECRETS_DIR=${target_root}/secrets
TLS_DIR=${target_root}/tls
BACKUP_DIR=${target_root}/backups
EDGE_BIND_PORT=${RESTORE_EDGE_PORT:-28443}
REDIS_BIND_PORT=${RESTORE_REDIS_PORT:-26379}
EOF

set -a
# shellcheck disable=SC1090
source "${target_root}/production.env"
set +a

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose=(docker compose --env-file "${target_root}/production.env" -f "${root}/deploy/docker/compose.prod.yml")
if docker ps -a --format '{{.Names}}' | grep -q "^${target_project}-"; then echo 'Target project already has containers.' >&2; exit 1; fi
if docker volume ls --format '{{.Name}}' | grep -q "^${target_project}_"; then echo 'Target project already has volumes.' >&2; exit 1; fi

"${compose[@]}" up -d postgres
postgres_container="$("${compose[@]}" ps -q postgres)"
for _ in {1..30}; do
  [[ $(docker inspect --format '{{.State.Health.Status}}' "${postgres_container}") == healthy ]] && break
  sleep 2
done
if [[ $(docker inspect --format '{{.State.Health.Status}}' "${postgres_container}") != healthy ]]; then
  echo 'Restored PostgreSQL did not become healthy.' >&2
  exit 1
fi
"${compose[@]}" exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges -U "${POSTGRES_USER:-feishu_agent}" -d "${POSTGRES_DB:-feishu_agent}" < "${staging}/postgres.dump"

redis_volume="${target_project}_redis-data"
docker volume create "${redis_volume}" >/dev/null
redis_seed_container="${target_project}-redis-seed"
docker create --name "${redis_seed_container}" -v "${redis_volume}:/data" alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -c 'chmod 600 /data/dump.rdb' >/dev/null
docker cp "${staging}/redis.rdb" "${redis_seed_container}:/data/dump.rdb" >/dev/null
docker start -a "${redis_seed_container}" >/dev/null
docker rm "${redis_seed_container}" >/dev/null
redis_seed_container=''
"${compose[@]}" up -d redis
redis_container="$("${compose[@]}" ps -q redis)"
for _ in {1..30}; do
  [[ $(docker inspect --format '{{.State.Health.Status}}' "${redis_container}") == healthy ]] && break
  sleep 2
done
if [[ $(docker inspect --format '{{.State.Health.Status}}' "${redis_container}") != healthy ]]; then
  echo 'Restored Redis did not become healthy.' >&2
  exit 1
fi

database_rows="$("${compose[@]}" exec -T postgres psql -At -U "${POSTGRES_USER:-feishu_agent}" -d "${POSTGRES_DB:-feishu_agent}" -c 'select count(*) from schema_migrations')"
redis_ping="$("${compose[@]}" exec -T redis sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" redis-cli --tls --cacert /run/secrets/internal-ca --cert /run/secrets/linux-client-cert --key /run/secrets/linux-client-key ping')"
if [[ ! ${database_rows} =~ ^[0-9]+$ || ${redis_ping} != PONG ]]; then echo 'Restored data verification failed.' >&2; exit 1; fi
printf '{"restoredAt":"%s","project":"%s","schemaMigrations":%s,"redis":"%s","verified":true}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${target_project}" "${database_rows}" "${redis_ping}" > "${target_root}/reports/restore-report.json"

echo "Clean restore verified for project ${target_project}. Report: ${target_root}/reports/restore-report.json"
