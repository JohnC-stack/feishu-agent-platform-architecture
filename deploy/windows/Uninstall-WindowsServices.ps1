#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'FeishuAgent'),
    [switch]$RemoveProgramFiles
)

$ErrorActionPreference = 'Stop'
$install = [System.IO.Path]::GetFullPath($InstallRoot)
$programFilesRoot = [System.IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\')
if (-not $install.StartsWith($programFilesRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Install root must remain under Program Files: $install"
}

foreach ($name in @('FeishuAgentGateway', 'FeishuAgentWorker')) {
    $wrapper = Join-Path $install "services\$name.exe"
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
        Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
        if (-not $PSCmdlet.ShouldProcess($name, 'uninstall Windows service')) { continue }
        & $wrapper uninstall
        if ($LASTEXITCODE -ne 0) { throw "WinSW failed to uninstall $name with exit code $LASTEXITCODE." }
    }
}
foreach ($ruleName in @('FeishuAgent-Gateway-mTLS', 'FeishuAgent-Worker-mTLS')) {
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
}

if ($RemoveProgramFiles -and $PSCmdlet.ShouldProcess($install, 'remove versioned program files')) {
    Remove-Item -LiteralPath $install -Recurse -Force
}

Write-Output 'Services and firewall rules removed. ProgramData, secrets, certificates, logs, and task state were preserved.'
