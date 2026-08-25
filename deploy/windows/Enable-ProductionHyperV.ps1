#Requires -RunAsAdministrator

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$dism = Join-Path $env:SystemRoot 'System32\dism.exe'
$rebootRequired = $false
foreach ($feature in @('Microsoft-Hyper-V-All', 'Microsoft-Hyper-V-Management-PowerShell')) {
    & $dism /online /enable-feature "/featurename:$feature" /all /norestart
    if ($LASTEXITCODE -eq 3010) { $rebootRequired = $true; continue }
    if ($LASTEXITCODE -ne 0) { throw "Failed to enable $feature. DISM exit code: $LASTEXITCODE" }
}

if ($rebootRequired) {
    Write-Warning 'Hyper-V was enabled and Windows must restart before VM provisioning.'
    exit 3010
}
Write-Output 'Hyper-V and its PowerShell management module are enabled.'
