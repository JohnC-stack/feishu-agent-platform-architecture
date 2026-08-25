#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [string[]]$ServiceNames = @('FeishuAgentGateway', 'FeishuAgentWorker'),
    [PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'
if (-not $Credential) {
    $Credential = Get-Credential -Message 'Enter the dedicated Windows service account. The password is sent directly to SCM and is not written to disk.'
}

$password = $Credential.GetNetworkCredential().Password
try {
    foreach ($serviceName in $ServiceNames) {
        $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
        $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
            StartName = $Credential.UserName
            StartPassword = $password
        }
        if ($result.ReturnValue -ne 0) {
            throw "SCM rejected the account change for $serviceName with code $($result.ReturnValue)."
        }
        Restart-Service -Name $serviceName -Force
    }
}
finally {
    $password = $null
}

Get-CimInstance -ClassName Win32_Service | Where-Object Name -In $ServiceNames | Select-Object Name, StartName, State, StartMode
