#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
: "${WINDOWS_HOST_ADDRESS:?Set WINDOWS_HOST_ADDRESS to the Hyper-V host address.}"
: "${ADMIN_ALLOWED_CIDR:?Set ADMIN_ALLOWED_CIDR to a specific internal host or subnet.}"
if [[ ${WINDOWS_HOST_ADDRESS} == '0.0.0.0' || ${ADMIN_ALLOWED_CIDR} == '0.0.0.0/0' ]]; then
  echo 'Wildcard firewall sources are forbidden.' >&2
  exit 1
fi

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow from "${WINDOWS_HOST_ADDRESS}" to any port 6379 proto tcp comment 'Windows Gateway Redis TLS'
ufw allow from "${WINDOWS_HOST_ADDRESS}" to any port 443 proto tcp comment 'Windows mTLS and admin HTTPS'
if [[ ${ADMIN_ALLOWED_CIDR} != "${WINDOWS_HOST_ADDRESS}/32" ]]; then
  ufw allow from "${ADMIN_ALLOWED_CIDR}" to any port 443 proto tcp comment 'Internal admin HTTPS'
fi
if [[ -n ${SSH_ALLOWED_CIDR:-} ]]; then
  if [[ ${SSH_ALLOWED_CIDR} == '0.0.0.0/0' ]]; then echo 'Wildcard SSH source is forbidden.' >&2; exit 1; fi
  ufw allow from "${SSH_ALLOWED_CIDR}" to any port 22 proto tcp comment 'Restricted administration'
fi
ufw --force enable
ufw status verbose
