[CmdletBinding()]
param(
    [uri]$GatewayHealthUri = 'https://windows-host.internal:3100/health/ready',
    [uri]$WorkerHealthUri = 'https://windows-host.internal:3200/health/ready',
    [string]$ClientCertificateThumbprint,
    [string]$DataRoot = (Join-Path $env:ProgramData 'FeishuAgent'),
    [int]$TimeoutSeconds = 10,
    [int]$RetryCount = 12
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'state\active-release.json'
if (-not $ClientCertificateThumbprint -and (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $ClientCertificateThumbprint = (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).clientCertificateThumbprint
}
if (-not $ClientCertificateThumbprint) { throw 'Windows mTLS client certificate thumbprint is required.' }
$certificate = $null
$certificate = Get-Item -LiteralPath "Cert:\LocalMachine\My\$ClientCertificateThumbprint" -ErrorAction Stop

$results = foreach ($service in @(
    @{ Name = 'FeishuAgentGateway'; Uri = $GatewayHealthUri },
    @{ Name = 'FeishuAgentWorker'; Uri = $WorkerHealthUri }
)) {
    $status = Get-Service -Name $service.Name -ErrorAction Stop
    if ($status.Status -ne 'Running') { throw "$($service.Name) is not running." }
    $parameters = @{ Uri = $service.Uri; TimeoutSec = $TimeoutSeconds; UseBasicParsing = $true; Certificate = $certificate }
    $response = $null
    $lastError = $null
    foreach ($attempt in 1..$RetryCount) {
        try {
            $response = Invoke-RestMethod @parameters
            $failedChecks = @($response.checks | Where-Object { -not $_.ok })
            if ($response.status -eq 'ok' -and $failedChecks.Count -eq 0) { break }
        }
        catch { $lastError = $_ }
        Start-Sleep -Seconds 2
    }
    $failedChecks = if ($null -ne $response) { @($response.checks | Where-Object { -not $_.ok }) } else { @() }
    if ($null -eq $response -or $response.status -ne 'ok' -or $failedChecks.Count -gt 0) {
        $failureDetail = if ($lastError) { $lastError.Exception.Message } else { "status=$($response.status); failedChecks=$($failedChecks.Count)" }
        throw "$($service.Name) readiness check failed after $RetryCount attempts: $failureDetail"
    }
    [pscustomobject]@{ Service = $service.Name; Status = $status.Status; Ready = $true; Uri = $service.Uri }
}
$results
