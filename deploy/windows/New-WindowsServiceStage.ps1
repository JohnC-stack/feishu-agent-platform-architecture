[CmdletBinding()]
param(
    [string]$SourceEnvironmentFile = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.env'),
    [string]$SourceTlsDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-linux\tls'),
    [string]$SourceSecretsDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-linux\secrets'),
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-windows-stage')
)

$ErrorActionPreference = 'Stop'
$environmentFile = [IO.Path]::GetFullPath($SourceEnvironmentFile)
$sourceTls = [IO.Path]::GetFullPath($SourceTlsDirectory)
$sourceSecrets = [IO.Path]::GetFullPath($SourceSecretsDirectory)
$output = [IO.Path]::GetFullPath($OutputDirectory)
foreach ($required in @($environmentFile, $sourceTls, $sourceSecrets)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required staging source is missing: $required" }
}
if (Test-Path -LiteralPath $output) { throw "Refusing to overwrite Windows service stage: $output" }

$appIdLine = Get-Content -LiteralPath $environmentFile | Where-Object { $_ -match '^FEISHU_APP_ID=' } | Select-Object -Last 1
if (-not $appIdLine) { throw 'FEISHU_APP_ID is missing from the source environment file.' }
$appId = $appIdLine.Split('=', 2)[1].Trim().Trim('"').Trim("'")
if ($appId -notmatch '^cli_[A-Za-z0-9]+$') { throw 'FEISHU_APP_ID has an unexpected format.' }

$tlsFiles = @('ca.pem', 'windows-client.pem', 'windows-client-key.pem', 'gateway.pem', 'gateway-key.pem', 'worker.pem', 'worker-key.pem')
$secretMap = @{
    'feishu-app-secret' = 'feishu-app-secret'
    'redis-url-windows' = 'redis-url'
}
foreach ($name in $tlsFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceTls $name) -PathType Leaf)) { throw "Required TLS file is missing: $name" }
}
foreach ($name in $secretMap.Keys) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceSecrets $name) -PathType Leaf)) { throw "Required secret file is missing: $name" }
}

$configDirectory = Join-Path $output 'config'
$tlsDirectory = Join-Path $output 'tls'
$secretsDirectory = Join-Path $output 'secrets'
New-Item -ItemType Directory -Path $configDirectory, $tlsDirectory, $secretsDirectory -Force | Out-Null

$gatewayEnvironment = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'gateway.env.example') -Raw).Replace('FEISHU_APP_ID=replace-with-app-id', "FEISHU_APP_ID=$appId")
if ($gatewayEnvironment -notmatch 'FEISHU_APP_SECRET=filecred://C:/ProgramData/FeishuAgent/secrets/feishu-app-secret' -or $gatewayEnvironment -notmatch 'REDIS_URL=filecred://C:/ProgramData/FeishuAgent/secrets/redis-url') {
    throw 'Gateway environment template does not use the required credential file references.'
}
$gatewayEnvironment | Set-Content -LiteralPath (Join-Path $configDirectory 'gateway.env') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'worker.env.example') -Raw | Set-Content -LiteralPath (Join-Path $configDirectory 'worker.env') -Encoding utf8NoBOM
foreach ($name in $tlsFiles) { Copy-Item -LiteralPath (Join-Path $sourceTls $name) -Destination (Join-Path $tlsDirectory $name) }
foreach ($entry in $secretMap.GetEnumerator()) { Copy-Item -LiteralPath (Join-Path $sourceSecrets $entry.Key) -Destination (Join-Path $secretsDirectory $entry.Value) }

$clientCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(
    (Join-Path $tlsDirectory 'windows-client.pem'),
    (Join-Path $tlsDirectory 'windows-client-key.pem')
)
$pfxPasswordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
$pfxPassword = [Convert]::ToBase64String($pfxPasswordBytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
$pfxPath = Join-Path $tlsDirectory 'windows-client.pfx'
$pfxPasswordPath = Join-Path $secretsDirectory 'windows-client-pfx-password'
[IO.File]::WriteAllBytes($pfxPath, $clientCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pfxPassword))
$clientCertificate.Dispose()
$pfxPassword | Set-Content -LiteralPath $pfxPasswordPath -Encoding ascii
$pfxPassword = $null

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $output /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$currentSid`:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict the Windows service staging ACL.' }

[pscustomobject]@{
    StageDirectory = $output
    GatewayEnvironment = Join-Path $configDirectory 'gateway.env'
    WorkerEnvironment = Join-Path $configDirectory 'worker.env'
    TlsFiles = $tlsFiles.Count + 1
    SecretFiles = $secretMap.Count + 1
    ContainsInlineSecrets = $false
}
