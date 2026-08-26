[CmdletBinding()]
param(
    [string]$SourceEnvironmentFile = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.env'),
    [string]$SourceTlsDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-linux\tls'),
    [string]$SourceSecretsDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-linux\secrets'),
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-windows-stage')
)

$ErrorActionPreference = 'Stop'

function Read-EnvironmentValues {
    param([string]$Path)
    $values = @{}
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    foreach ($line in [IO.File]::ReadAllLines([IO.Path]::GetFullPath($Path), $utf8)) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^\s*([^=]+)=(.*)$') { continue }
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($value -match '[\r\n]') { throw "Environment value contains a line break: $name" }
        $values[$name] = $value
    }
    return $values
}

function Replace-WorkerSetting {
    param([string]$Content, [string]$Placeholder, [AllowEmptyString()][string]$Value)
    if (-not $Content.Contains($Placeholder)) { throw "Worker environment placeholder is missing: $Placeholder" }
    return $Content.Replace($Placeholder, $Value)
}
$environmentFile = [IO.Path]::GetFullPath($SourceEnvironmentFile)
$sourceTls = [IO.Path]::GetFullPath($SourceTlsDirectory)
$sourceSecrets = [IO.Path]::GetFullPath($SourceSecretsDirectory)
$output = [IO.Path]::GetFullPath($OutputDirectory)
foreach ($required in @($environmentFile, $sourceTls, $sourceSecrets)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required staging source is missing: $required" }
}
if (Test-Path -LiteralPath $output) { throw "Refusing to overwrite Windows service stage: $output" }

$environmentValues = Read-EnvironmentValues -Path $environmentFile
$appId = $environmentValues['FEISHU_APP_ID']
if (-not $appId) { throw 'FEISHU_APP_ID is missing from the source environment file.' }
if ($appId -notmatch '^cli_[A-Za-z0-9]+$') { throw 'FEISHU_APP_ID has an unexpected format.' }
$gitlabBaseUrl = $environmentValues['GITLAB_BASE_URL']
$gitlabTokenReference = $environmentValues['GITLAB_TOKEN']
if ($gitlabBaseUrl) {
    $parsedGitlabUrl = $null
    if (-not [Uri]::TryCreate($gitlabBaseUrl, [UriKind]::Absolute, [ref]$parsedGitlabUrl) -or $parsedGitlabUrl.Scheme -notin @('http', 'https') -or $parsedGitlabUrl.UserInfo) {
        throw 'GITLAB_BASE_URL must be an HTTP(S) URL without embedded credentials.'
    }
}
if ($gitlabTokenReference -and $gitlabTokenReference -notmatch '^filecred://') {
    throw 'GITLAB_TOKEN must use a service-safe filecred:// reference for production staging.'
}
$confluenceWrapper = $environmentValues['CONFLUENCE_CLI_WRAPPER']
$confluenceBaseUrl = $environmentValues['CONFLUENCE_BASE_URL']
$confluenceUsername = $environmentValues['CONFLUENCE_USERNAME']
$confluencePasswordReference = $environmentValues['CONFLUENCE_PASSWORD']
$confluenceDirectValues = @($confluenceBaseUrl, $confluenceUsername, $confluencePasswordReference) | Where-Object { $_ }
if ($confluenceDirectValues.Count -gt 0 -and $confluenceDirectValues.Count -ne 3) {
    throw 'Direct Confluence service configuration requires CONFLUENCE_BASE_URL, CONFLUENCE_USERNAME, and CONFLUENCE_PASSWORD together.'
}
if ($confluenceBaseUrl) {
    $parsedConfluenceUrl = $null
    if (-not [Uri]::TryCreate($confluenceBaseUrl, [UriKind]::Absolute, [ref]$parsedConfluenceUrl) -or $parsedConfluenceUrl.Scheme -notin @('http', 'https') -or $parsedConfluenceUrl.UserInfo) {
        throw 'CONFLUENCE_BASE_URL must be an HTTP(S) URL without embedded credentials.'
    }
}
if ($confluencePasswordReference -and $confluencePasswordReference -notmatch '^filecred://') {
    throw 'CONFLUENCE_PASSWORD must use a service-safe filecred:// reference for production staging.'
}
$confluenceDirectConfigured = [bool]($confluenceBaseUrl -and $confluenceUsername -and $confluencePasswordReference)
if (-not $confluenceDirectConfigured -and $confluenceWrapper -and -not (Test-Path -LiteralPath $confluenceWrapper -PathType Leaf)) {
    throw 'CONFLUENCE_CLI_WRAPPER does not reference an existing file.'
}
$confluenceWorkerWrapper = if ($confluenceDirectConfigured) { '' } else { $confluenceWrapper }

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
if ($gatewayEnvironment -notmatch 'FEISHU_APP_SECRET=filecred://D:/FeishuAgent/data/secrets/feishu-app-secret' -or $gatewayEnvironment -notmatch 'REDIS_URL=filecred://D:/FeishuAgent/data/secrets/redis-url') {
    throw 'Gateway environment template does not use the required credential file references.'
}
$gatewayEnvironment | Set-Content -LiteralPath (Join-Path $configDirectory 'gateway.env') -Encoding utf8NoBOM
$workerEnvironment = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'worker.env.example') -Raw
$workerSettings = [ordered]@{
    'replace-with-feishu-app-id' = $appId
    'replace-with-feishu-document-ids' = $environmentValues['FEISHU_ALLOWED_DOCUMENT_IDS']
    'replace-with-feishu-bitable-tokens' = $environmentValues['FEISHU_ALLOWED_BITABLE_APP_TOKENS']
    'replace-with-feishu-chat-ids' = $environmentValues['FEISHU_ALLOWED_CHAT_IDS']
    'replace-with-feishu-user-ids' = $environmentValues['FEISHU_ALLOWED_USER_IDS']
    'replace-with-gitlab-base-url' = $gitlabBaseUrl
    'replace-with-gitlab-token-reference' = $gitlabTokenReference
    'replace-with-gitlab-projects' = $environmentValues['GITLAB_ALLOWED_PROJECTS']
    'replace-with-confluence-base-url' = $confluenceBaseUrl
    'replace-with-confluence-username' = $confluenceUsername
    'replace-with-confluence-password-reference' = $confluencePasswordReference
    'replace-with-confluence-cli-wrapper' = $confluenceWorkerWrapper
    'replace-with-confluence-space-keys' = $environmentValues['CONFLUENCE_ALLOWED_SPACE_KEYS']
    'replace-with-confluence-page-ids' = $environmentValues['CONFLUENCE_ALLOWED_PAGE_IDS']
}
foreach ($entry in $workerSettings.GetEnumerator()) {
    $settingValue = if ($null -eq $entry.Value) { '' } else { [string]$entry.Value }
    $workerEnvironment = Replace-WorkerSetting -Content $workerEnvironment -Placeholder $entry.Key -Value $settingValue
}
$workerEnvironment | Set-Content -LiteralPath (Join-Path $configDirectory 'worker.env') -Encoding utf8NoBOM
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
    WorkerIntegrations = @{
        Feishu = [bool]($appId -and ($environmentValues['FEISHU_ALLOWED_DOCUMENT_IDS'] -or $environmentValues['FEISHU_ALLOWED_BITABLE_APP_TOKENS'] -or $environmentValues['FEISHU_ALLOWED_CHAT_IDS'] -or $environmentValues['FEISHU_ALLOWED_USER_IDS']))
        GitLab = [bool]($gitlabBaseUrl -and $gitlabTokenReference -and $environmentValues['GITLAB_ALLOWED_PROJECTS'])
        Confluence = [bool](($confluenceDirectConfigured -or $confluenceWrapper) -and $environmentValues['CONFLUENCE_ALLOWED_SPACE_KEYS'])
    }
    RequiresUserProfileServiceAccount = [bool](($gitlabTokenReference -like 'wincred://*') -or (-not $confluenceDirectConfigured -and $confluenceWrapper))
}
