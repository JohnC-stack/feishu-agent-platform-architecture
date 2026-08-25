[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DestinationDirectory,
    [Parameter(Mandatory)]
    [string]$SourceEnvironmentFile,
    [string]$PostgresUser = 'feishu_agent',
    [string]$PostgresDatabase = 'feishu_agent',
    [string]$RedisWindowsHost = 'redis.feishu-agent.internal'
)

$ErrorActionPreference = 'Stop'

function New-Base64UrlSecret([int]$Bytes = 48) {
    $buffer = [byte[]]::new($Bytes)
    [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-DotEnvValue([string]$Path, [string]$Name) {
    $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    $value = $line.Substring($line.IndexOf('=') + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        return $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Write-SecretFile([string]$Directory, [string]$Name, [string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { throw "Secret $Name must not be empty." }
    $path = Join-Path $Directory $Name
    [IO.File]::WriteAllText($path, $Value, [Text.UTF8Encoding]::new($false))
}

$source = [IO.Path]::GetFullPath($SourceEnvironmentFile)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Environment file is missing: $source" }
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
if ([IO.Path]::GetPathRoot($destination).TrimEnd('\') -eq $destination.TrimEnd('\')) {
    throw 'Secret destination must not be a filesystem root.'
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null

$feishuSecret = Read-DotEnvValue -Path $source -Name 'FEISHU_APP_SECRET'
if ([string]::IsNullOrWhiteSpace($feishuSecret)) { throw 'Source environment must contain FEISHU_APP_SECRET.' }

$postgresPassword = New-Base64UrlSecret
$redisPassword = New-Base64UrlSecret
$grafanaPassword = New-Base64UrlSecret 32
$encodedPostgresPassword = [Uri]::EscapeDataString($postgresPassword)
$encodedRedisPassword = [Uri]::EscapeDataString($redisPassword)

Write-SecretFile $destination 'postgres-password' $postgresPassword
Write-SecretFile $destination 'database-url' "postgres://${PostgresUser}:$encodedPostgresPassword@postgres:5432/${PostgresDatabase}"
Write-SecretFile $destination 'redis-password' $redisPassword
Write-SecretFile $destination 'redis-url' "rediss://default:$encodedRedisPassword@redis:6379"
Write-SecretFile $destination 'redis-url-windows' "rediss://default:$encodedRedisPassword@${RedisWindowsHost}:6379"
if ($feishuSecret.StartsWith('filecred://') -or $feishuSecret.StartsWith('wincred://')) {
    $env:FEISHU_AGENT_SOURCE_REFERENCE = $feishuSecret
    $env:FEISHU_AGENT_SECRET_OUTPUT = Join-Path $destination 'feishu-app-secret'
    try {
        & node (Join-Path $PSScriptRoot 'resolve-credential-reference.mjs')
        if ($LASTEXITCODE -ne 0) { throw "Credential reference resolution failed with exit code $LASTEXITCODE." }
    }
    finally {
        Remove-Item Env:\FEISHU_AGENT_SOURCE_REFERENCE -ErrorAction SilentlyContinue
        Remove-Item Env:\FEISHU_AGENT_SECRET_OUTPUT -ErrorAction SilentlyContinue
    }
}
else {
    Write-SecretFile $destination 'feishu-app-secret' $feishuSecret
}
Write-SecretFile $destination 'grafana-admin-password' $grafanaPassword

if ($env:OS -eq 'Windows_NT') {
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $destination /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$currentUserSid`:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict the generated secret directory ACL.' }
}

[pscustomobject]@{
    Directory = $destination
    SecretFiles = 7
    ContainsPlaintextInOutput = $false
}
