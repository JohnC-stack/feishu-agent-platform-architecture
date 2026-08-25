[CmdletBinding()]
param(
    [string]$DestinationDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-winsw-cache'),
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'deployment-manifest.json'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$destination = [System.IO.Path]::GetFullPath($DestinationDirectory)
$target = Join-Path $destination 'WinSW-x64.exe'
New-Item -ItemType Directory -Path $destination -Force | Out-Null

if ($Force -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
    $temporary = Join-Path $destination ('WinSW-x64.{0}.download' -f [guid]::NewGuid().ToString('N'))
    try {
        Invoke-WebRequest -Uri $manifest.winsw.url -OutFile $temporary -UseBasicParsing
        Move-Item -LiteralPath $temporary -Destination $target -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

$actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($actualHash -ne $manifest.winsw.sha256) {
    throw "WinSW SHA256 mismatch. Expected $($manifest.winsw.sha256), received $actualHash."
}

Get-Item -LiteralPath $target | Select-Object FullName, Length, @{ Name = 'SHA256'; Expression = { $actualHash } }
