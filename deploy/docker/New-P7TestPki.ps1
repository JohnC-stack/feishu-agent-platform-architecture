[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$OutputDirectory,
    [string]$AdminDomain = 'feishu-agent.internal',
    [string]$WindowsControlDomain = 'feishu-agent-windows.internal',
    [string]$WindowsHostName = 'windows-host.internal',
    [string]$RedisHostName = 'redis.feishu-agent.internal'
)

$ErrorActionPreference = 'Stop'
foreach ($name in @($AdminDomain, $WindowsControlDomain, $WindowsHostName, $RedisHostName)) {
    if ($name -notmatch '^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
        throw "Invalid DNS name: $name"
    }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required to generate the P7 test PKI.' }

$output = [IO.Path]::GetFullPath($OutputDirectory)
if ([IO.Path]::GetPathRoot($output).TrimEnd('\') -eq $output.TrimEnd('\')) { throw 'PKI output must not be a filesystem root.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$mountSource = $output.Replace('\', '/')

$script = @'
set -eu
apk add --no-cache openssl >/dev/null
cd /out
umask 077

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ca-key.pem >/dev/null 2>&1
openssl req -x509 -new -sha256 -key ca-key.pem -days 825 -subj "/CN=Feishu Agent P7 Test CA" -out ca.pem

issue_server() {
  name="$1"
  common_name="$2"
  san="$3"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${name}-key.pem" >/dev/null 2>&1
  openssl req -new -sha256 -key "${name}-key.pem" -subj "/CN=${common_name}" -out "${name}.csr"
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' "$san" > "${name}.ext"
  openssl x509 -req -sha256 -in "${name}.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 397 -extfile "${name}.ext" -out "${name}.pem" >/dev/null 2>&1
  rm -f "${name}.csr" "${name}.ext"
}

issue_client() {
  name="$1"
  common_name="$2"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${name}-key.pem" >/dev/null 2>&1
  openssl req -new -sha256 -key "${name}-key.pem" -subj "/CN=${common_name}" -out "${name}.csr"
  printf 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n' > "${name}.ext"
  openssl x509 -req -sha256 -in "${name}.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 397 -extfile "${name}.ext" -out "${name}.pem" >/dev/null 2>&1
  rm -f "${name}.csr" "${name}.ext"
}

issue_server edge "$ADMIN_DOMAIN" "DNS:$ADMIN_DOMAIN,DNS:$WINDOWS_CONTROL_DOMAIN"
issue_server redis redis "DNS:redis,DNS:$REDIS_HOST_NAME"
issue_server gateway "$WINDOWS_HOST_NAME" "DNS:$WINDOWS_HOST_NAME"
issue_server worker "$WINDOWS_HOST_NAME" "DNS:$WINDOWS_HOST_NAME"
issue_client linux-client feishu-agent-linux-control
issue_client windows-client feishu-agent-windows-gateway
chmod 600 *-key.pem ca-key.pem
chmod 644 *.pem
openssl verify -CAfile ca.pem edge.pem redis.pem gateway.pem worker.pem linux-client.pem windows-client.pem >/dev/null
'@

& docker run --rm `
    --mount "type=bind,source=$mountSource,target=/out" `
    --env "ADMIN_DOMAIN=$AdminDomain" `
    --env "WINDOWS_CONTROL_DOMAIN=$WindowsControlDomain" `
    --env "WINDOWS_HOST_NAME=$WindowsHostName" `
    --env "REDIS_HOST_NAME=$RedisHostName" `
    'alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce' `
    /bin/sh -c $script
if ($LASTEXITCODE -ne 0) { throw "Test PKI generation failed with exit code $LASTEXITCODE." }

[pscustomobject]@{
    Directory = $output
    CertificateFiles = (Get-ChildItem -LiteralPath $output -Filter '*.pem' -File).Count
    TestOnly = $true
}
