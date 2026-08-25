[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ReleasePath
)

$ErrorActionPreference = 'Stop'

function Get-PortableRelativePath {
    param([string]$BasePath, [string]$TargetPath)
    $base = [IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $target = [IO.Path]::GetFullPath($TargetPath)
    $baseUri = [Uri]::new($base)
    $targetUri = [Uri]::new($target)
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

$release = [System.IO.Path]::GetFullPath($ReleasePath)
$manifestPath = Join-Path $release 'release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Release manifest is missing: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($link in @(Get-ChildItem -LiteralPath $release -Recurse -Force -Attributes ReparsePoint)) {
    $targets = @($link.Target)
    if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) {
        throw "Release link must have exactly one target: $($link.FullName)"
    }
    $target = [string]$targets[0]
    if (-not [IO.Path]::IsPathRooted($target)) {
        $target = Join-Path $link.Directory.FullName $target
    }
    $target = [IO.Path]::GetFullPath($target)
    $relativeTarget = Get-PortableRelativePath -BasePath $release -TargetPath $target
    if ([IO.Path]::IsPathRooted($relativeTarget) -or $relativeTarget.StartsWith('..')) {
        throw "Release link points outside release root: $($link.FullName) -> $target"
    }
    if (-not (Test-Path -LiteralPath $target)) {
        throw "Release link target is missing: $($link.FullName) -> $target"
    }
}
foreach ($entry in $manifest.files) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $release $entry.path))
    if (-not $candidate.StartsWith($release + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release manifest path escapes release root: $($entry.path)"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Release file is missing: $($entry.path)"
    }
    $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    if ($actualHash -ne $entry.sha256) {
        throw "Release file hash mismatch: $($entry.path)"
    }
}

foreach ($entryPoint in @('gateway\dist\index.js', 'worker\dist\index.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $release $entryPoint) -PathType Leaf)) {
        throw "Windows service entry point is missing: $entryPoint"
    }
}

[pscustomobject]@{
    Version = $manifest.version
    Commit = $manifest.commit
    Files = @($manifest.files).Count
    Valid = $true
}
