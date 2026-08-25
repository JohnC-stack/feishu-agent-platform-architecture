[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) '.runtime\p7-hyperv\autoinstall'),
    [ValidatePattern('^[0-9A-Fa-f]{12}$')]
    [string]$StaticMacAddress = '00155D64010A',
    [ValidatePattern('^[a-z][a-z0-9-]{1,31}$')]
    [string]$Username = 'feishuops',
    [ValidatePattern('^[a-z][a-z0-9-]{1,62}$')]
    [string]$Hostname = 'feishu-agent-control'
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBomFile {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Content, [Text.UTF8Encoding]::new($false))
}

function New-Sha512CryptHash {
    param([Parameter(Mandatory)][string]$Password)

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command docker -ErrorAction Stop).Source
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = 'run --rm -i alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -lc "apk add --no-cache openssl >/dev/null && openssl passwd -6 -stdin"'

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Failed to start Docker for password hashing.' }
    try {
        # PowerShell native-command piping writes CRLF on Windows. OpenSSL hashes the
        # trailing CR in that case, so write one explicit LF through redirected stdin.
        $process.StandardInput.Write($Password)
        $process.StandardInput.Write("`n")
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $hash = $stdoutTask.GetAwaiter().GetResult().Trim()
        $null = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or $hash -notmatch '^\$6\$') {
            throw 'Failed to create the Ubuntu bootstrap password hash.'
        }
        return $hash
    }
    finally {
        $process.Dispose()
    }
}

foreach ($command in @('docker', 'ssh-keygen')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command is unavailable: $command"
    }
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
$seedDirectory = Join-Path $output 'cidata'
$seedIso = Join-Path $output 'seed.iso'
$privateKey = Join-Path $output 'id_ed25519'
$publicKey = "$privateKey.pub"
$passwordFile = Join-Path $output 'bootstrap-password.txt'
foreach ($path in @($seedIso, $privateKey, $publicKey, $passwordFile)) {
    if (Test-Path -LiteralPath $path) {
        throw "Refusing to overwrite existing autoinstall artifact: $path"
    }
}

New-Item -ItemType Directory -Path $seedDirectory -Force | Out-Null
& ssh-keygen -q -t ed25519 -f $privateKey -N '' -C 'feishu-agent-p7-bootstrap'
if ($LASTEXITCODE -ne 0) { throw "ssh-keygen failed with exit code $LASTEXITCODE." }
$authorizedKey = (Get-Content -LiteralPath $publicKey -Raw).Trim()
if ($authorizedKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+ feishu-agent-p7-bootstrap$') {
    throw 'Generated SSH public key has an unexpected format.'
}

$randomBytes = New-Object byte[] 24
$randomNumberGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $randomNumberGenerator.GetBytes($randomBytes) }
finally { $randomNumberGenerator.Dispose() }
$bootstrapPassword = [Convert]::ToBase64String($randomBytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
$passwordHash = New-Sha512CryptHash -Password $bootstrapPassword

$macAddress = (($StaticMacAddress -split '(..)' | Where-Object { $_ }) -join ':').ToLowerInvariant()
$userData = @"
#cloud-config
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard:
    layout: us
  timezone: Asia/Shanghai
  apt:
    geoip: false
    fallback: offline-install
  network:
    version: 2
    ethernets:
      control:
        match:
          macaddress: $macAddress
        set-name: eth0
        addresses:
          - 192.168.100.10/24
        routes:
          - to: default
            via: 192.168.100.1
        nameservers:
          addresses:
            - 223.5.5.5
            - 1.1.1.1
  storage:
    layout:
      name: lvm
      sizing-policy: all
  identity:
    hostname: $Hostname
    username: $Username
    password: "$passwordHash"
  ssh:
    install-server: true
    allow-pw: false
    authorized-keys:
      - $authorizedKey
  late-commands:
    - curtin in-target -- systemctl enable ssh
    - curtin in-target -- ufw default deny incoming
    - curtin in-target -- ufw default allow outgoing
    - curtin in-target -- ufw allow from 192.168.100.1 to any port 22 proto tcp
    - curtin in-target -- ufw --force enable
  shutdown: reboot
"@
$metaData = @"
instance-id: feishu-agent-p7
local-hostname: $Hostname
"@

Write-Utf8NoBomFile -Path (Join-Path $seedDirectory 'user-data') -Content $userData
Write-Utf8NoBomFile -Path (Join-Path $seedDirectory 'meta-data') -Content $metaData
[IO.File]::WriteAllText($passwordFile, $bootstrapPassword, [Text.Encoding]::ASCII)
$bootstrapPassword = $null

docker run --rm --mount "type=bind,source=$seedDirectory,target=/seed" alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -lc 'apk add --no-cache xorriso >/dev/null && xorriso -as mkisofs -quiet -output /seed/seed.iso -volid cidata -joliet -rock /seed/user-data /seed/meta-data'
if ($LASTEXITCODE -ne 0) { throw "Seed ISO creation failed with exit code $LASTEXITCODE." }
Move-Item -LiteralPath (Join-Path $seedDirectory 'seed.iso') -Destination $seedIso

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $output /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$currentSid`:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict the autoinstall artifact ACL.' }

[pscustomobject]@{
    SeedIso = $seedIso
    PrivateKey = $privateKey
    PublicKey = $publicKey
    BootstrapPasswordFile = $passwordFile
    StaticMacAddress = $StaticMacAddress.ToUpperInvariant()
    VmAddress = '192.168.100.10'
}
