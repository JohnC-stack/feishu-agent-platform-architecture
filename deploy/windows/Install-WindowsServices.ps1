#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$ReleasePath,
    [Parameter(Mandatory)]
    [string]$GatewayEnvironmentFile,
    [Parameter(Mandatory)]
    [string]$WorkerEnvironmentFile,
    [Parameter(Mandatory)]
    [string]$TlsSourceDirectory,
    [Parameter(Mandatory)]
    [string]$SecretsSourceDirectory,
    [Parameter(Mandatory)]
    [System.Net.IPAddress]$LinuxVmAddress,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'FeishuAgent'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'FeishuAgent'),
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [string]$WinSWPath = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-winsw-cache\WinSW-x64.exe')
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBomFile {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Content, [Text.UTF8Encoding]::new($false))
}

function Install-ServiceWrapper {
    param($Name, $Template, $EnvironmentFile, $EntryPoint, $LogPath, $ServiceDirectory, $WinSW, $CommonReplacements)
    $executable = Join-Path $ServiceDirectory "$Name.exe"
    $configuration = Join-Path $ServiceDirectory "$Name.xml"
    Copy-Item -LiteralPath $WinSW -Destination $executable -Force
    $xml = Get-Content -LiteralPath $Template -Raw
    $values = @{} + $CommonReplacements
    $values['__ENV_PATH__'] = ConvertTo-XmlText $EnvironmentFile
    $values['__APP_PATH__'] = ConvertTo-XmlText $EntryPoint
    $values['__LOG_PATH__'] = ConvertTo-XmlText $LogPath
    foreach ($key in $values.Keys) { $xml = $xml.Replace($key, $values[$key]) }
    Write-Utf8NoBomFile -Path $configuration -Content $xml
    & $executable install
    if ($LASTEXITCODE -ne 0) { throw "WinSW failed to install $Name with exit code $LASTEXITCODE." }
}

function Set-ActiveJunction {
    param([string]$LinkPath, [string]$TargetPath, [string]$AllowedRoot)
    $link = [System.IO.Path]::GetFullPath($LinkPath)
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    $root = [System.IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
    foreach ($path in @($link, $target)) {
        if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Junction path is outside install root: $path"
        }
    }
    if (Test-Path -LiteralPath $link) {
        $existing = Get-Item -LiteralPath $link -Force
        if (-not ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to replace a non-junction path: $link"
        }
        [IO.Directory]::Delete($link)
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

function ConvertTo-XmlText([string]$Value) {
    return [System.Security.SecurityElement]::Escape($Value)
}

function Set-RestrictedAcl {
    param([string]$Path, [string]$IdentitySid, [string]$Rights)
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$IdentitySid`:(OI)(CI)$Rights" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to set restricted ACL on $Path." }
}

function Add-RequiredHostsEntry {
    param([string]$Address, [string]$HostName)
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $matching = Get-Content -LiteralPath $hostsPath | Where-Object { $_ -notmatch '^\s*#' -and $_ -match "(^|\s)$([regex]::Escape($HostName))(\s|$)" }
    if ($matching) {
        if ($matching | Where-Object { $_ -notmatch "^\s*$([regex]::Escape($Address))\s" }) {
            throw "Hosts entry for $HostName already points to another address."
        }
        return
    }
    Add-Content -LiteralPath $hostsPath -Value "$Address`t$HostName" -Encoding ascii
}

$release = [System.IO.Path]::GetFullPath($ReleasePath)
$install = [System.IO.Path]::GetFullPath($InstallRoot)
$data = [System.IO.Path]::GetFullPath($DataRoot)
$node = [System.IO.Path]::GetFullPath($NodePath)
$winSw = [System.IO.Path]::GetFullPath($WinSWPath)
$tlsSource = [System.IO.Path]::GetFullPath($TlsSourceDirectory)
$secretsSource = [System.IO.Path]::GetFullPath($SecretsSourceDirectory)

& (Join-Path $PSScriptRoot 'Test-WindowsRelease.ps1') -ReleasePath $release | Out-Null
foreach ($required in @($GatewayEnvironmentFile, $WorkerEnvironmentFile, $node, $winSw)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file is missing: $required"
    }
}
$tlsFiles = @('ca.pem', 'windows-client.pem', 'windows-client-key.pem', 'windows-client.pfx', 'gateway.pem', 'gateway-key.pem', 'worker.pem', 'worker-key.pem')
$secretFiles = @('feishu-app-secret', 'redis-url', 'windows-client-pfx-password')
foreach ($name in $tlsFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $tlsSource $name) -PathType Leaf)) { throw "Required TLS staging file is missing: $name" }
}
foreach ($name in $secretFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $secretsSource $name) -PathType Leaf)) { throw "Required secret staging file is missing: $name" }
}
$expectedWinSwHash = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-manifest.json') -Raw | ConvertFrom-Json).winsw.sha256
$actualWinSwHash = (Get-FileHash -LiteralPath $winSw -Algorithm SHA256).Hash
if ($actualWinSwHash -ne $expectedWinSwHash) {
    throw "WinSW SHA256 mismatch. Expected $expectedWinSwHash, received $actualWinSwHash."
}
foreach ($serviceName in @('FeishuAgentGateway', 'FeishuAgentWorker')) {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        throw "Service already exists: $serviceName. Use the release switch script for upgrades."
    }
}

$version = (Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json).version
$targetRelease = Join-Path (Join-Path $install 'releases') $version
$reuseInstalledRelease = $false
if (Test-Path -LiteralPath $targetRelease) {
    $sourceManifestHash = (Get-FileHash -LiteralPath (Join-Path $release 'release-manifest.json') -Algorithm SHA256).Hash
    $installedManifestHash = (Get-FileHash -LiteralPath (Join-Path $targetRelease 'release-manifest.json') -Algorithm SHA256).Hash
    if ($sourceManifestHash -ne $installedManifestHash) {
        throw "Installed release manifest does not match the requested source: $targetRelease"
    }
    & (Join-Path $PSScriptRoot 'Test-WindowsRelease.ps1') -ReleasePath $targetRelease | Out-Null
    $reuseInstalledRelease = $true
}

if (-not $PSCmdlet.ShouldProcess($install, "install Windows services release $version")) { return }

foreach ($directory in @(
    $targetRelease,
    (Join-Path $install 'current'),
    (Join-Path $install 'services'),
    (Join-Path $data 'config'),
    (Join-Path $data 'logs\gateway'),
    (Join-Path $data 'logs\worker'),
    (Join-Path $data 'state'),
    (Join-Path $data 'tasks'),
    (Join-Path $data 'tls'),
    (Join-Path $data 'secrets')
)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

if (-not $reuseInstalledRelease) {
    & (Join-Path $PSScriptRoot 'Copy-PortableRelease.ps1') -SourcePath $release -DestinationPath $targetRelease | Out-Null
    & (Join-Path $PSScriptRoot 'Test-WindowsRelease.ps1') -ReleasePath $targetRelease | Out-Null
}
Copy-Item -LiteralPath $GatewayEnvironmentFile -Destination (Join-Path $data 'config\gateway.env') -Force
Copy-Item -LiteralPath $WorkerEnvironmentFile -Destination (Join-Path $data 'config\worker.env') -Force
foreach ($name in $tlsFiles) { Copy-Item -LiteralPath (Join-Path $tlsSource $name) -Destination (Join-Path $data "tls\$name") -Force }
foreach ($name in $secretFiles) { Copy-Item -LiteralPath (Join-Path $secretsSource $name) -Destination (Join-Path $data "secrets\$name") -Force }

$caCertificate = Import-Certificate -FilePath (Join-Path $data 'tls\ca.pem') -CertStoreLocation 'Cert:\LocalMachine\Root'
$pfxPassword = Get-Content -LiteralPath (Join-Path $data 'secrets\windows-client-pfx-password') -Raw
$clientCertificate = Import-PfxCertificate -FilePath (Join-Path $data 'tls\windows-client.pfx') -CertStoreLocation 'Cert:\LocalMachine\My' -Password (ConvertTo-SecureString $pfxPassword.Trim() -AsPlainText -Force)
$pfxPassword = $null
if (-not $clientCertificate.HasPrivateKey) { throw 'Imported Windows mTLS client certificate has no private key.' }
Add-RequiredHostsEntry -Address '127.0.0.1' -HostName 'windows-host.internal'
Add-RequiredHostsEntry -Address $LinuxVmAddress.IPAddressToString -HostName 'feishu-agent.internal'
Add-RequiredHostsEntry -Address $LinuxVmAddress.IPAddressToString -HostName 'feishu-agent-windows.internal'
Add-RequiredHostsEntry -Address $LinuxVmAddress.IPAddressToString -HostName 'redis.feishu-agent.internal'

Set-RestrictedAcl -Path (Join-Path $install 'releases') -IdentitySid '*S-1-5-19' -Rights 'RX'
foreach ($protectedPath in @((Join-Path $data 'config'), (Join-Path $data 'tls'), (Join-Path $data 'secrets'))) {
    Set-RestrictedAcl -Path $protectedPath -IdentitySid '*S-1-5-19' -Rights 'RX'
}
foreach ($writablePath in @((Join-Path $data 'logs'), (Join-Path $data 'state'), (Join-Path $data 'tasks'))) {
    Set-RestrictedAcl -Path $writablePath -IdentitySid '*S-1-5-19' -Rights 'M'
}

Set-ActiveJunction -LinkPath (Join-Path $install 'current\gateway') -TargetPath (Join-Path $targetRelease 'gateway') -AllowedRoot $install
Set-ActiveJunction -LinkPath (Join-Path $install 'current\worker') -TargetPath (Join-Path $targetRelease 'worker') -AllowedRoot $install

$serviceDirectory = Join-Path $install 'services'
$replacements = @{
    '__NODE_PATH__' = (ConvertTo-XmlText $node)
    '__WORKING_DIRECTORY__' = (ConvertTo-XmlText $install)
}
Install-ServiceWrapper -Name 'FeishuAgentGateway' -Template (Join-Path $PSScriptRoot 'service.gateway.xml.template') -EnvironmentFile (Join-Path $data 'config\gateway.env') -EntryPoint (Join-Path $install 'current\gateway\dist\index.js') -LogPath (Join-Path $data 'logs\gateway') -ServiceDirectory $serviceDirectory -WinSW $winSw -CommonReplacements $replacements
Install-ServiceWrapper -Name 'FeishuAgentWorker' -Template (Join-Path $PSScriptRoot 'service.worker.xml.template') -EnvironmentFile (Join-Path $data 'config\worker.env') -EntryPoint (Join-Path $install 'current\worker\dist\index.js') -LogPath (Join-Path $data 'logs\worker') -ServiceDirectory $serviceDirectory -WinSW $winSw -CommonReplacements $replacements

foreach ($rule in @(
    @{ Name = 'FeishuAgent-Gateway-mTLS'; Port = 3100 },
    @{ Name = 'FeishuAgent-Worker-mTLS'; Port = 3200 }
)) {
    Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Port -RemoteAddress $LinuxVmAddress.IPAddressToString -Profile Domain,Private | Out-Null
}

$activeReleaseJson = @{ version = $version; installedAt = [DateTimeOffset]::UtcNow.ToString('O'); clientCertificateThumbprint = $clientCertificate.Thumbprint; caCertificateThumbprint = $caCertificate.Thumbprint } | ConvertTo-Json
Write-Utf8NoBomFile -Path (Join-Path $data 'state\active-release.json') -Content $activeReleaseJson

foreach ($serviceName in @('FeishuAgentGateway', 'FeishuAgentWorker')) {
    Start-Service -Name $serviceName
}
& (Join-Path $PSScriptRoot 'Test-WindowsServices.ps1') -ClientCertificateThumbprint $clientCertificate.Thumbprint
