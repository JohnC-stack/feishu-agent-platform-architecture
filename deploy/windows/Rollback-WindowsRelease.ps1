#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'FeishuAgent'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'FeishuAgent'),
    [string]$ClientCertificateThumbprint
)

$ErrorActionPreference = 'Stop'
$previousStatePath = Join-Path ([System.IO.Path]::GetFullPath($DataRoot)) 'state\previous-release.json'
if (-not (Test-Path -LiteralPath $previousStatePath -PathType Leaf)) {
    throw 'No previous Windows release is available for rollback.'
}
$previous = Get-Content -LiteralPath $previousStatePath -Raw | ConvertFrom-Json
$release = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) 'releases') $previous.version
& (Join-Path $PSScriptRoot 'Switch-WindowsRelease.ps1') -ReleasePath $release -InstallRoot $InstallRoot -DataRoot $DataRoot -ClientCertificateThumbprint $ClientCertificateThumbprint -Confirm:$false
