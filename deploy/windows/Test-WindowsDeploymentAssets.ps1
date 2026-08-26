[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()
$scripts = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File
foreach ($script in $scripts) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        $errors.Add("$($script.Name): $($parseError.Message)")
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.winsw.version -ne '2.12.0' -or $manifest.winsw.sha256 -notmatch '^[A-F0-9]{64}$') {
    $errors.Add('WinSW version or SHA256 pin is invalid.')
}
foreach ($templateName in @('service.gateway.xml.template', 'service.worker.xml.template')) {
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot $templateName) -Raw
    try { [xml]$template | Out-Null } catch { $errors.Add("$templateName is not valid XML: $($_.Exception.Message)") }
    foreach ($token in @('__NODE_PATH__', '__ENV_PATH__', '__APP_PATH__', '__WORKING_DIRECTORY__', '__LOG_PATH__')) {
        if (-not $template.Contains($token)) { $errors.Add("$templateName is missing $token.") }
    }
}
$workerEnvironment = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'worker.env.example') -Raw
foreach ($token in @(
    'replace-with-feishu-app-id',
    'replace-with-gitlab-base-url',
    'replace-with-gitlab-token-reference',
    'replace-with-gitlab-projects',
    'replace-with-confluence-base-url',
    'replace-with-confluence-username',
    'replace-with-confluence-password-reference',
    'replace-with-confluence-cli-wrapper',
    'replace-with-confluence-space-keys'
)) {
    if (-not $workerEnvironment.Contains($token)) { $errors.Add("worker.env.example is missing $token.") }
}
if ($workerEnvironment -notmatch 'FEISHU_APP_SECRET=filecred://') {
    $errors.Add('worker.env.example must use a file credential reference for FEISHU_APP_SECRET.')
}
if ($workerEnvironment -notmatch 'CONFLUENCE_PASSWORD=replace-with-confluence-password-reference') {
    $errors.Add('worker.env.example must expose the staged Confluence password reference.')
}
if ($errors.Count -gt 0) { throw ($errors -join [Environment]::NewLine) }

[pscustomobject]@{
    Scripts = $scripts.Count
    Templates = 2
    ManifestVersion = $manifest.schemaVersion
    Valid = $true
}
