#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$InstallerIsoPath,
    [string]$AutoinstallSeedIsoPath,
    [string]$VmName = 'FeishuAgent-ControlPlane',
    [string]$SwitchName = 'FeishuAgent-Internal',
    [string]$NatName = 'FeishuAgent-NAT',
    [string]$Subnet = '192.168.100.0/24',
    [string]$HostAddress = '192.168.100.1',
    [UInt64]$MemoryStartupBytes = 8GB,
    [UInt64]$DiskSizeBytes = 120GB,
    [int]$ProcessorCount = 4,
    [ValidatePattern('^[0-9A-Fa-f]{12}$')]
    [string]$StaticMacAddress = '00155D64010A',
    [string]$VmRoot = (Join-Path $env:ProgramData 'Microsoft\Windows\Hyper-V\FeishuAgent')
)

$ErrorActionPreference = 'Stop'
$iso = [IO.Path]::GetFullPath($InstallerIsoPath)
if (-not (Test-Path -LiteralPath $iso -PathType Leaf)) { throw "Linux installer ISO is missing: $iso" }
$seedIso = $null
if (-not [string]::IsNullOrWhiteSpace($AutoinstallSeedIsoPath)) {
    $seedIso = [IO.Path]::GetFullPath($AutoinstallSeedIsoPath)
    if (-not (Test-Path -LiteralPath $seedIso -PathType Leaf)) { throw "Autoinstall seed ISO is missing: $seedIso" }
}
foreach ($command in @('Get-VM', 'New-VM', 'New-VMSwitch')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Hyper-V command is unavailable: $command" }
}
if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }

$root = [IO.Path]::GetFullPath($VmRoot)
$vhdPath = Join-Path $root "$VmName.vhdx"
if (-not $PSCmdlet.ShouldProcess($VmName, 'create isolated Linux control-plane VM')) { return }
New-Item -ItemType Directory -Path $root -Force | Out-Null

if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
    New-VMSwitch -Name $SwitchName -SwitchType Internal | Out-Null
}
$adapterAlias = "vEthernet ($SwitchName)"
if (-not (Get-NetIPAddress -InterfaceAlias $adapterAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object IPAddress -eq $HostAddress)) {
    New-NetIPAddress -InterfaceAlias $adapterAlias -IPAddress $HostAddress -PrefixLength 24 | Out-Null
}
if (-not (Get-NetNat -Name $NatName -ErrorAction SilentlyContinue)) {
    New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix $Subnet | Out-Null
}

New-VM -Name $VmName -Generation 2 -MemoryStartupBytes $MemoryStartupBytes -NewVHDPath $vhdPath -NewVHDSizeBytes $DiskSizeBytes -SwitchName $SwitchName | Out-Null
Set-VM -Name $VmName -ProcessorCount $ProcessorCount -AutomaticStartAction StartIfRunning -AutomaticStopAction ShutDown -AutomaticStartDelay 30
Set-VMNetworkAdapter -VMName $VmName -StaticMacAddress $StaticMacAddress
Set-VMFirmware -VMName $VmName -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true -MinimumBytes 4GB -StartupBytes $MemoryStartupBytes -MaximumBytes 16GB
Add-VMDvdDrive -VMName $VmName -Path $iso | Out-Null
$dvd = Get-VMDvdDrive -VMName $VmName
if ($seedIso) { Add-VMDvdDrive -VMName $VmName -Path $seedIso | Out-Null }
Set-VMFirmware -VMName $VmName -FirstBootDevice $dvd

Get-VM -Name $VmName | Select-Object Name, State, Generation, ProcessorCount, MemoryStartup, @{ Name = 'StaticMacAddress'; Expression = { $StaticMacAddress } }, @{ Name = 'AutoinstallSeed'; Expression = { $seedIso } }
