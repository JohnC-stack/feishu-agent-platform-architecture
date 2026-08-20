#Requires -RunAsAdministrator

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$dism = Join-Path $env:SystemRoot 'System32\dism.exe'
$rebootRequired = $false

foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
    & $dism /online /enable-feature "/featurename:$feature" /all /norestart
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 3010) {
        $rebootRequired = $true
        continue
    }

    if ($exitCode -ne 0) {
        throw "Failed to enable Windows feature '$feature'. DISM exit code: $exitCode"
    }
}

if ($rebootRequired) {
    exit 3010
}

exit 0
