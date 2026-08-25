#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$ReleasePath,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'FeishuAgent'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'FeishuAgent'),
    [string]$ClientCertificateThumbprint,
    [int]$HealthTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBomFile {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Content, [Text.UTF8Encoding]::new($false))
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

$release = [System.IO.Path]::GetFullPath($ReleasePath)
$install = [System.IO.Path]::GetFullPath($InstallRoot)
$data = [System.IO.Path]::GetFullPath($DataRoot)
& (Join-Path $PSScriptRoot 'Test-WindowsRelease.ps1') -ReleasePath $release | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json).version
$targetRelease = Join-Path (Join-Path $install 'releases') $version
$statePath = Join-Path $data 'state\active-release.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw "Active release state is missing: $statePath"
}
$previousState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$previousRelease = Join-Path (Join-Path $install 'releases') $previousState.version
if (-not (Test-Path -LiteralPath $previousRelease -PathType Container)) {
    throw "Previous release directory is missing: $previousRelease"
}
if ($version -eq $previousState.version) {
    throw "Release $version is already active."
}

if (-not $PSCmdlet.ShouldProcess($install, "switch release $($previousState.version) to $version")) { return }

if (Test-Path -LiteralPath $targetRelease) {
    $sourceManifestHash = (Get-FileHash -LiteralPath (Join-Path $release 'release-manifest.json') -Algorithm SHA256).Hash
    $installedManifestHash = (Get-FileHash -LiteralPath (Join-Path $targetRelease 'release-manifest.json') -Algorithm SHA256).Hash
    if ($sourceManifestHash -ne $installedManifestHash) {
        throw "Installed release manifest does not match the requested source: $targetRelease"
    }
}
else {
    & (Join-Path $PSScriptRoot 'Copy-PortableRelease.ps1') -SourcePath $release -DestinationPath $targetRelease | Out-Null
}
& (Join-Path $PSScriptRoot 'Test-WindowsRelease.ps1') -ReleasePath $targetRelease | Out-Null

Stop-Service -Name 'FeishuAgentGateway', 'FeishuAgentWorker' -Force
try {
    Set-ActiveJunction -LinkPath (Join-Path $install 'current\gateway') -TargetPath (Join-Path $targetRelease 'gateway') -AllowedRoot $install
    Set-ActiveJunction -LinkPath (Join-Path $install 'current\worker') -TargetPath (Join-Path $targetRelease 'worker') -AllowedRoot $install
    Start-Service -Name 'FeishuAgentGateway', 'FeishuAgentWorker'
    Start-Sleep -Seconds 2
    & (Join-Path $PSScriptRoot 'Test-WindowsServices.ps1') -ClientCertificateThumbprint $ClientCertificateThumbprint -TimeoutSeconds $HealthTimeoutSeconds | Out-Null
}
catch {
    Stop-Service -Name 'FeishuAgentGateway', 'FeishuAgentWorker' -Force -ErrorAction SilentlyContinue
    Set-ActiveJunction -LinkPath (Join-Path $install 'current\gateway') -TargetPath (Join-Path $previousRelease 'gateway') -AllowedRoot $install
    Set-ActiveJunction -LinkPath (Join-Path $install 'current\worker') -TargetPath (Join-Path $previousRelease 'worker') -AllowedRoot $install
    Start-Service -Name 'FeishuAgentGateway', 'FeishuAgentWorker'
    throw "Release $version failed health checks and was rolled back to $($previousState.version): $($_.Exception.Message)"
}

Write-Utf8NoBomFile -Path (Join-Path $data 'state\previous-release.json') -Content ($previousState | ConvertTo-Json)
$activeState = [ordered]@{
    version = $version
    installedAt = [DateTimeOffset]::UtcNow.ToString('O')
}
foreach ($propertyName in @('clientCertificateThumbprint', 'caCertificateThumbprint')) {
    $property = $previousState.PSObject.Properties[$propertyName]
    if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        $activeState[$propertyName] = [string]$property.Value
    }
}
Write-Utf8NoBomFile -Path $statePath -Content ($activeState | ConvertTo-Json)

[pscustomobject]@{ Previous = $previousState.version; Active = $version; Healthy = $true }
