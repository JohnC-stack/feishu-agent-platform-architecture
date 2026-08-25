#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this script as root on the Hyper-V Linux VM.' >&2
  exit 1
fi
if grep -qi microsoft /proc/sys/kernel/osrelease; then
  echo 'Production control plane must run in the Hyper-V VM, not WSL or Docker Desktop.' >&2
  exit 1
fi
if [[ ! -d /run/systemd/system ]]; then
  echo 'A systemd-based Ubuntu or Debian VM is required.' >&2
  exit 1
fi

. /etc/os-release
case "${ID}" in
  ubuntu|debian) ;;
  *) echo "Unsupported Linux distribution: ${ID}" >&2; exit 1 ;;
esac

apt-get update
apt-get install -y ca-certificates curl age ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
arch="$(dpkg --print-architecture)"
codename="${VERSION_CODENAME}"
printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "${ID}" "${codename}" "${arch}" > /etc/apt/sources.list.d/docker.sources
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

secret_group=feishu-agent-secrets
secret_gid=${FEISHU_AGENT_SECRET_GID:-1999}
if existing_gid="$(getent group "${secret_group}" | cut -d: -f3)" && [[ -n ${existing_gid} ]]; then
  if [[ ${existing_gid} != "${secret_gid}" ]]; then
    echo "${secret_group} already exists with GID ${existing_gid}; expected ${secret_gid}." >&2
    exit 1
  fi
elif getent group "${secret_gid}" >/dev/null; then
  echo "GID ${secret_gid} is already assigned to another group." >&2
  exit 1
else
  groupadd --gid "${secret_gid}" "${secret_group}"
fi

install -d -m 0750 -o root -g root /opt/feishu-agent /opt/feishu-agent/backups
install -d -m 0750 -o root -g "${secret_group}" /opt/feishu-agent/secrets /opt/feishu-agent/tls
install -d -m 0750 -o root -g root /var/lib/feishu-agent/releases
if [[ -d /opt/feishu-agent/deploy ]]; then
  find /opt/feishu-agent/deploy -type f -name '*.sh' -exec chmod 0755 {} +
fi
install -m 0644 "$(dirname "$0")/feishu-agent-compose.service" /etc/systemd/system/feishu-agent-compose.service
systemctl daemon-reload

docker version --format 'Docker Engine {{.Server.Version}}'
docker compose version
echo 'Linux host prerequisites installed. Configure firewall, TLS, secrets, and production.env before enabling the stack.'
