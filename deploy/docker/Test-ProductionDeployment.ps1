[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$EnvironmentFile,
    [string]$ComposeFile = (Join-Path $PSScriptRoot 'compose.prod.yml')
)

$ErrorActionPreference = 'Stop'
$environment = [IO.Path]::GetFullPath($EnvironmentFile)
$compose = [IO.Path]::GetFullPath($ComposeFile)
foreach ($required in @($environment, $compose)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required deployment file is missing: $required" }
}

$json = & docker compose --env-file $environment -f $compose config --format json
if ($LASTEXITCODE -ne 0) { throw "docker compose config failed with exit code $LASTEXITCODE." }
$configuration = $json | ConvertFrom-Json -Depth 100
$allowedPublishedPorts = @(443, 6379)
foreach ($serviceProperty in $configuration.services.PSObject.Properties) {
    foreach ($port in @($serviceProperty.Value.ports | Where-Object { $null -ne $_ })) {
        if ($port.published -notin $allowedPublishedPorts) {
            throw "Unexpected published port on $($serviceProperty.Name): $($port.published)"
        }
        if ([string]::IsNullOrWhiteSpace($port.host_ip) -or $port.host_ip -in @('0.0.0.0', '::')) {
            throw "Published port $($port.published) is not bound to the Hyper-V internal address."
        }
    }
}
if ($null -ne $configuration.services.postgres.ports) { throw 'PostgreSQL must not publish a host port.' }
if ($null -ne $configuration.services.'control-api'.ports -or $null -ne $configuration.services.grafana.ports -or $null -ne $configuration.services.prometheus.ports) {
    throw 'Control API and observability services must remain behind the edge proxy.'
}

[pscustomobject]@{
    Services = @($configuration.services.PSObject.Properties).Count
    PublishedPorts = $allowedPublishedPorts -join ','
    PublicWildcardBindings = 0
    Valid = $true
}
