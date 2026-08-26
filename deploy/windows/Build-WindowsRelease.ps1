[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$')]
    [string]$Version,
    [string]$OutputRoot = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-windows-releases'),
    [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$releasePath = Join-Path $outputRootPath $Version

if (Test-Path -LiteralPath $releasePath) {
    throw "Release already exists: $releasePath"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is required to build a Windows release.'
}

$sourceStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=normal)
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect the Git working tree.' }
$workingTreeDirty = $sourceStatus.Count -gt 0
if ($workingTreeDirty -and -not $AllowDirty) {
    throw 'Refusing to build a production release from a dirty Git working tree. Commit the reviewed changes or pass -AllowDirty for a traceable temporary candidate.'
}
$diffSha256 = $null
if ($workingTreeDirty) {
    $diffText = (& git -C $repositoryRoot diff --binary HEAD | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Failed to capture the Git working-tree diff.' }
    $diffBytes = [Text.Encoding]::UTF8.GetBytes($diffText)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $diffSha256 = ([BitConverter]::ToString($hasher.ComputeHash($diffBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
Push-Location $repositoryRoot
try {
    & pnpm build:packages
    if ($LASTEXITCODE -ne 0) { throw "Package build failed with exit code $LASTEXITCODE." }
    & pnpm --filter '@feishu-agent/feishu-gateway' run build
    if ($LASTEXITCODE -ne 0) { throw "Gateway build failed with exit code $LASTEXITCODE." }
    & pnpm --filter '@feishu-agent/windows-worker' run build
    if ($LASTEXITCODE -ne 0) { throw "Worker build failed with exit code $LASTEXITCODE." }

    & pnpm --config.inject-workspace-packages=true deploy --filter '@feishu-agent/feishu-gateway' --prod (Join-Path $releasePath 'gateway')
    if ($LASTEXITCODE -ne 0) { throw "Gateway deployment failed with exit code $LASTEXITCODE." }
    & pnpm --config.inject-workspace-packages=true deploy --filter '@feishu-agent/windows-worker' --prod (Join-Path $releasePath 'worker')
    if ($LASTEXITCODE -ne 0) { throw "Worker deployment failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

$files = Get-ChildItem -LiteralPath $releasePath -Recurse -File | Sort-Object FullName
$hashes = foreach ($file in $files) {
    [ordered]@{
        path = [System.IO.Path]::GetRelativePath($releasePath, $file.FullName).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        bytes = $file.Length
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    createdAt = [DateTimeOffset]::UtcNow.ToString('O')
    commit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
    source = [ordered]@{
        workingTreeDirty = $workingTreeDirty
        diffSha256 = $diffSha256
    }
    node = (& node --version).Trim()
    pnpm = (& pnpm --version).Trim()
    files = @($hashes)
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $releasePath 'release-manifest.json') -Encoding utf8NoBOM

Write-Output $releasePath
