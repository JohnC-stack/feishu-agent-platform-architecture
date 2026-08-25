#!/bin/sh
set -eu

password="$(cat /run/secrets/redis-password)"
case "$password" in
  *[!A-Za-z0-9_-]*|'')
    echo 'redis-password must be a non-empty base64url value.' >&2
    exit 1
    ;;
esac

umask 077
printf 'user default on >%s ~* +@all\n' "$password" > /run/redis/users.acl
unset password

exec redis-server \
  --port 0 \
  --tls-port 6379 \
  --tls-cert-file /run/secrets/redis-cert \
  --tls-key-file /run/secrets/redis-key \
  --tls-ca-cert-file /run/secrets/internal-ca \
  --tls-auth-clients yes \
  --aclfile /run/redis/users.acl \
  --appendonly yes \
  --appendfsync everysec \
  --maxmemory-policy noeviction
