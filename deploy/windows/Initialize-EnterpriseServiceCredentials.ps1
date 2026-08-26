[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$SourceEnvironmentFile,
    [string]$DataRoot = 'D:\FeishuAgent\data',
    [string]$ConfluenceCliLauncher = 'D:\Codex\confluence-cli\cfl.ps1',
    [switch]$ValidateConfigurationOnly
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($SourceEnvironmentFile)) {
    $repositoryRoot = Split-Path -Parent (Split-Path -Parent $scriptDirectory)
    $SourceEnvironmentFile = Join-Path $repositoryRoot '.env'
}

function Assert-Administrator {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This credential initializer must run from an elevated administrator window.'
    }
}

function Read-EnvironmentValues {
    param([string]$Path)
    $values = @{}
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    foreach ($line in [IO.File]::ReadAllLines([IO.Path]::GetFullPath($Path), $utf8)) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^\s*([^=]+)=(.*)$') { continue }
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$name] = $value
    }
    return $values
}

function Read-WindowsCredentialSecret {
    param([string]$Target)
    if (-not ('FeishuAgent.WinCredReader' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FeishuAgent {
  public static class WinCredReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public UInt32 Flags;
      public UInt32 Type;
      public IntPtr TargetName;
      public IntPtr Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public UInt32 CredentialBlobSize;
      public IntPtr CredentialBlob;
      public UInt32 Persist;
      public UInt32 AttributeCount;
      public IntPtr Attributes;
      public IntPtr TargetAlias;
      public IntPtr UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    private static extern void CredFree(IntPtr credential);

    public static string Read(string target) {
      IntPtr pointer;
      if (!CredRead(target, 1, 0, out pointer)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Credential target was not found or cannot be read.");
      }
      try {
        Credential credential = Marshal.PtrToStructure<Credential>(pointer);
        if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return string.Empty;
        return Marshal.PtrToStringUni(credential.CredentialBlob, checked((int)credential.CredentialBlobSize / 2));
      } finally {
        CredFree(pointer);
      }
    }
  }
}
'@
    }
    $value = [FeishuAgent.WinCredReader]::Read($Target)
    if ([string]::IsNullOrEmpty($value)) { throw 'Windows Credential Manager returned an empty GitLab token.' }
    return $value
}

function Set-RestrictedAcl {
    param([string]$Path, [switch]$Directory)
    $grants = if ($Directory) {
        @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-19:(OI)(CI)RX')
    } else {
        @('*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-19:R')
    }
    & icacls.exe $Path /inheritance:r /grant:r $grants | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to restrict ACL: $Path" }
}

function Write-ProtectedSecret {
    param([string]$Path, [string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { throw 'Refusing to write an empty service secret.' }
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
    Set-RestrictedAcl -Path $Path
}

$environmentFile = [IO.Path]::GetFullPath($SourceEnvironmentFile)
$data = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if ($data -ne 'D:\FeishuAgent\data') { throw 'The approved service data root is D:\FeishuAgent\data.' }
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) { throw "Environment file is missing: $environmentFile" }
$values = Read-EnvironmentValues -Path $environmentFile

$gitlabBaseUrl = $values['GITLAB_BASE_URL']
$gitlabReference = $values['GITLAB_TOKEN']
$confluenceBaseUrl = $values['CONFLUENCE_BASE_URL']
$confluenceUsername = $values['CONFLUENCE_USERNAME']
if (-not $gitlabBaseUrl -or -not $gitlabReference) { throw 'GitLab base URL or token reference is missing.' }
if (-not $confluenceBaseUrl -or -not $confluenceUsername) { throw 'Confluence base URL or username is missing.' }
$gitlabUri = $null
if (-not [Uri]::TryCreate($gitlabBaseUrl, [UriKind]::Absolute, [ref]$gitlabUri) -or $gitlabUri.Scheme -notin @('http', 'https') -or $gitlabUri.UserInfo) {
    throw 'GitLab base URL must be HTTP(S) without embedded credentials.'
}
$confluenceUri = $null
if (-not [Uri]::TryCreate($confluenceBaseUrl, [UriKind]::Absolute, [ref]$confluenceUri) -or $confluenceUri.Scheme -notin @('http', 'https') -or $confluenceUri.UserInfo) {
    throw 'Confluence base URL must be HTTP(S) without embedded credentials.'
}
if ($gitlabReference -notmatch '^(wincred|filecred)://') { throw 'GitLab token reference must use wincred:// or filecred://.' }
if (-not (Test-Path -LiteralPath $ConfluenceCliLauncher -PathType Leaf)) { throw 'Registered Confluence CLI launcher is missing.' }
if ($ValidateConfigurationOnly) {
    [pscustomobject]@{
        EnvironmentFile = $environmentFile
        GitLabConfigured = $true
        ConfluenceConfigured = $true
        DataRoot = $data
    }
    return
}
Assert-Administrator

$gitlabToken = $null
$confluencePassword = $null
$credential = $null
try {
    if ($gitlabReference -like 'wincred://*') {
        $target = [Uri]::UnescapeDataString($gitlabReference.Substring('wincred://'.Length))
        if ($target -notlike 'FeishuAgent/*') { throw 'GitLab credential target is outside the approved prefix.' }
        $gitlabToken = Read-WindowsCredentialSecret -Target $target
    } elseif ($gitlabReference -like 'filecred://*') {
        $existingPath = [IO.Path]::GetFullPath([Uri]::UnescapeDataString($gitlabReference.Substring('filecred://'.Length)))
        $approvedSecretsRoot = [IO.Path]::GetFullPath((Join-Path $data 'secrets')).TrimEnd('\')
        $approvedPrefix = "$approvedSecretsRoot\"
        if (-not $existingPath.StartsWith($approvedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'GitLab file credential is outside the approved service secrets directory.'
        }
        $gitlabToken = (Get-Content -LiteralPath $existingPath -Raw).TrimEnd("`r", "`n")
    } else {
        throw 'GitLab token must use wincred:// or filecred://.'
    }

    $gitlabHeaders = @{ 'PRIVATE-TOKEN' = $gitlabToken }
    $gitlabIdentity = Invoke-RestMethod -Uri "$($gitlabBaseUrl.TrimEnd('/'))/api/v4/user" -Headers $gitlabHeaders -Method Get -TimeoutSec 15
    if (-not $gitlabIdentity.id) { throw 'GitLab token validation did not return an authenticated identity.' }

    $credential = Get-Credential -UserName $confluenceUsername -Message 'Enter the company Confluence password. It will only be stored in the protected local service secret file.'
    if (-not $credential) { throw 'Confluence credential input was cancelled.' }
    if ($credential.UserName -ne $confluenceUsername) { throw 'Confluence username must match the configured service username.' }
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
    try {
        $confluencePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }

    $previousConfluenceSecret = [Environment]::GetEnvironmentVariable('CONFLUENCE_CLI_SECRET_COMPANY', 'Process')
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        [Environment]::SetEnvironmentVariable('CONFLUENCE_CLI_SECRET_COMPANY', $confluencePassword, 'Process')
        $ErrorActionPreference = 'Continue'
        $confluenceValidationOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ConfluenceCliLauncher --profile company whoami 2>$null
        $confluenceValidationExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        [Environment]::SetEnvironmentVariable('CONFLUENCE_CLI_SECRET_COMPANY', $previousConfluenceSecret, 'Process')
    }
    if ($confluenceValidationExitCode -ne 0) {
        $confluenceValidationOutput = $null
        throw 'The registered Confluence CLI rejected the supplied credential.'
    }
    $confluenceValidationOutput = $null

    $secrets = Join-Path $data 'secrets'
    $backupRoot = Join-Path $data "backups\enterprise-secrets-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    if (-not $PSCmdlet.ShouldProcess($secrets, 'write validated GitLab and Confluence service credentials')) { return }
    New-Item -ItemType Directory -Path $secrets -Force | Out-Null
    Set-RestrictedAcl -Path $secrets -Directory
    $existing = @('gitlab-token', 'confluence-password') | Where-Object { Test-Path -LiteralPath (Join-Path $secrets $_) }
    if ($existing.Count -gt 0) {
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        Set-RestrictedAcl -Path $backupRoot -Directory
        foreach ($name in $existing) {
            Copy-Item -LiteralPath (Join-Path $secrets $name) -Destination (Join-Path $backupRoot $name)
            Set-RestrictedAcl -Path (Join-Path $backupRoot $name)
        }
    }
    Write-ProtectedSecret -Path (Join-Path $secrets 'gitlab-token') -Value $gitlabToken
    Write-ProtectedSecret -Path (Join-Path $secrets 'confluence-password') -Value $confluencePassword

    [pscustomobject]@{
        GitLabValidated = $true
        ConfluenceValidated = $true
        CredentialFilesWritten = 2
        SecretsDirectory = $secrets
        BackupCreated = [bool]($existing.Count -gt 0)
    }
} finally {
    $gitlabToken = $null
    $confluencePassword = $null
    $credential = $null
    $previousConfluenceSecret = $null
    $previousErrorActionPreference = $null
    $confluenceValidationOutput = $null
}
