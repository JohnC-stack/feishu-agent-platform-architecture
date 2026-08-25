[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SourcePath,
    [Parameter(Mandatory)]
    [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'

function Get-PortableRelativePath {
    param([string]$BasePath, [string]$TargetPath)
    $base = [IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $target = [IO.Path]::GetFullPath($TargetPath)
    $baseUri = [Uri]::new($base)
    $targetUri = [Uri]::new($target)
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

function Test-IsWithinRoot {
    param([string]$Candidate, [string]$Root)
    $relative = Get-PortableRelativePath -BasePath $Root -TargetPath $Candidate
    return $relative -eq '.' -or (-not [IO.Path]::IsPathRooted($relative) -and -not $relative.StartsWith('..'))
}

function Get-LinkTargetPath {
    param([IO.FileSystemInfo]$Link)
    $targets = @($Link.Target)
    if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) {
        throw "Release link must have exactly one target: $($Link.FullName)"
    }
    $target = [string]$targets[0]
    if (-not [IO.Path]::IsPathRooted($target)) {
        $target = Join-Path $Link.Directory.FullName $target
    }
    return [IO.Path]::GetFullPath($target)
}

$source = [IO.Path]::GetFullPath($SourcePath).TrimEnd('\')
$destination = [IO.Path]::GetFullPath($DestinationPath).TrimEnd('\')
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Release source does not exist: $source"
}
if ($source.Equals($destination, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release source and destination must be different directories.'
}
if (Test-Path -LiteralPath $destination) {
    if (@(Get-ChildItem -LiteralPath $destination -Force -ErrorAction Stop).Count -gt 0) {
        throw "Release destination must be empty: $destination"
    }
}
else {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
}

$sourceLinks = @(Get-ChildItem -LiteralPath $source -Recurse -Force -Attributes ReparsePoint)
$linkMap = foreach ($link in $sourceLinks) {
    if ($link.LinkType -notin @('Junction', 'SymbolicLink')) {
        throw "Unsupported release reparse point type $($link.LinkType): $($link.FullName)"
    }
    $sourceTarget = Get-LinkTargetPath -Link $link
    if (-not (Test-IsWithinRoot -Candidate $sourceTarget -Root $source)) {
        throw "Release link points outside source root: $($link.FullName) -> $sourceTarget"
    }
    [pscustomobject]@{
        LinkType = $link.LinkType
        LinkRelativePath = Get-PortableRelativePath -BasePath $source -TargetPath $link.FullName
        TargetRelativePath = Get-PortableRelativePath -BasePath $source -TargetPath $sourceTarget
        IsDirectory = $link.PSIsContainer
    }
}

& robocopy.exe $source $destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /SL /SJ /NP /NFL /NDL /NJH /NJS | Out-Null
$robocopyExitCode = $LASTEXITCODE
if ($robocopyExitCode -gt 7) {
    throw "Robocopy failed with exit code $robocopyExitCode."
}

foreach ($entry in $linkMap) {
    $destinationLink = Join-Path $destination $entry.LinkRelativePath
    $destinationTarget = Join-Path $destination $entry.TargetRelativePath
    $copiedLink = Get-Item -LiteralPath $destinationLink -Force -ErrorAction Stop
    if (-not ($copiedLink.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Robocopy did not preserve release link: $destinationLink"
    }
    if ($copiedLink.PSIsContainer) {
        [IO.Directory]::Delete($destinationLink)
    }
    else {
        [IO.File]::Delete($destinationLink)
    }
    if ($entry.LinkType -eq 'Junction') {
        New-Item -ItemType Junction -Path $destinationLink -Target $destinationTarget | Out-Null
    }
    else {
        New-Item -ItemType SymbolicLink -Path $destinationLink -Target $destinationTarget | Out-Null
    }
}

[pscustomobject]@{
    Source = $source
    Destination = $destination
    RobocopyExitCode = $robocopyExitCode
    RebasedLinks = $linkMap.Count
}
