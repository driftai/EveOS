param(
    [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Destination) {
    $Destination = Join-Path $Root 'tools\WatchFusion\tools\cloudflared.exe'
}

function Test-Cloudflared([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        & $Path --version *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Resolve-CloudflaredPath([string]$Path) {
    if (-not (Test-Cloudflared $Path)) { return $null }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Emit-IfValid([string]$Path, [string]$Source) {
    $Resolved = Resolve-CloudflaredPath $Path
    if (-not $Resolved) { return $false }
    Write-Verbose "Using cloudflared from $Source`: $Resolved"
    $script:ResolvedCloudflared = $Resolved
    return $true
}

$ResolvedCloudflared = $null

# Prefer an explicit EveOS override, then the current process PATH.
if ($env:EVEOS_CLOUDFLARED -and (Emit-IfValid $env:EVEOS_CLOUDFLARED 'EVEOS_CLOUDFLARED')) {
    Write-Output $ResolvedCloudflared
    exit 0
}

$Command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $Command) { $Command = Get-Command cloudflared -ErrorAction SilentlyContinue }
if ($Command -and (Emit-IfValid $Command.Source 'PATH')) {
    Write-Output $ResolvedCloudflared
    exit 0
}

# EveOS is often launched from a terminal that predates a cloudflared install,
# so PATH can be stale. Probe the common Windows install locations explicitly.
$KnownCandidates = @()
if (${env:ProgramFiles(x86)}) {
    $KnownCandidates += (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe')
    $KnownCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Cloudflare\cloudflared.exe')
}
if ($env:ProgramFiles) {
    $KnownCandidates += (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
    $KnownCandidates += (Join-Path $env:ProgramFiles 'Cloudflare\cloudflared.exe')
}
if ($env:LOCALAPPDATA) {
    $KnownCandidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\cloudflared.exe')
}
if ($env:USERPROFILE) {
    $KnownCandidates += (Join-Path $env:USERPROFILE '.cloudflared\cloudflared.exe')
}
foreach ($Candidate in $KnownCandidates | Select-Object -Unique) {
    if (Emit-IfValid $Candidate 'known Windows install location') {
        Write-Output $ResolvedCloudflared
        exit 0
    }
}

# Check App Paths in case an installer registered cloudflared without updating
# the PATH inherited by the already-running EveOS terminal.
$RegistryKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\cloudflared.exe',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\cloudflared.exe',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\cloudflared.exe'
)
foreach ($RegistryKey in $RegistryKeys) {
    try {
        $Registered = (Get-ItemProperty -LiteralPath $RegistryKey -ErrorAction Stop).'(default)'
        if ($Registered -and (Emit-IfValid $Registered 'Windows App Paths')) {
            Write-Output $ResolvedCloudflared
            exit 0
        }
    } catch {}
}

if (Emit-IfValid $Destination 'EveOS bundled tools') {
    Write-Output $ResolvedCloudflared
    exit 0
}

# Nothing usable is installed. Download the matching executable from Cloudflare's
# official GitHub release and verify the SHA256 digest published on that asset.
$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$Asset = switch ($Architecture) {
    'x86' { 'cloudflared-windows-386.exe' }
    'x86_32' { 'cloudflared-windows-386.exe' }
    'arm64' { 'cloudflared-windows-arm64.exe' }
    default { 'cloudflared-windows-amd64.exe' }
}
$ReleaseApi = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
$Directory = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$Temporary = "$Destination.download"
Remove-Item -Force -LiteralPath $Temporary -ErrorAction SilentlyContinue

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Headers = @{ 'User-Agent' = 'EveOS-cloudflared-bootstrap'; 'Accept' = 'application/vnd.github+json' }
    $Release = Invoke-RestMethod -Uri $ReleaseApi -Headers $Headers
    $ReleaseAsset = $Release.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
    if (-not $ReleaseAsset -or -not $ReleaseAsset.browser_download_url) {
        throw "Official Cloudflare release does not contain $Asset."
    }

    $ExpectedHash = ''
    if ([string]$ReleaseAsset.digest -match '^sha256:([a-fA-F0-9]{64})$') {
        $ExpectedHash = $Matches[1].ToLowerInvariant()
    }
    if (-not $ExpectedHash) {
        # Older GitHub release metadata did not expose asset digests. Keep a
        # release-body fallback for those releases without trusting an unchecked binary.
        $ChecksumPattern = '(?mi)^\s*' + [regex]::Escape($Asset) + '(?::|\s+)\s*([a-f0-9]{64})\s*$'
        $ChecksumMatch = [regex]::Match([string]$Release.body, $ChecksumPattern)
        if ($ChecksumMatch.Success) { $ExpectedHash = $ChecksumMatch.Groups[1].Value.ToLowerInvariant() }
    }
    if (-not $ExpectedHash) {
        throw "Official Cloudflare release metadata did not provide a SHA256 digest for $Asset."
    }

    Invoke-WebRequest -Uri $ReleaseAsset.browser_download_url -OutFile $Temporary -UseBasicParsing -Headers $Headers
    $ActualHash = (Get-FileHash -LiteralPath $Temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
        throw "Downloaded cloudflared SHA256 mismatch (expected $ExpectedHash, got $ActualHash)."
    }
    if (-not (Test-Cloudflared $Temporary)) {
        throw 'Downloaded cloudflared executable did not pass its version self-check.'
    }
    Move-Item -Force -LiteralPath $Temporary -Destination $Destination
} catch {
    Remove-Item -Force -LiteralPath $Temporary -ErrorAction SilentlyContinue
    throw "cloudflared is required and automatic resolution/download failed: $($_.Exception.Message)"
}

$Installed = Resolve-CloudflaredPath $Destination
if (-not $Installed) { throw 'cloudflared was downloaded but is not executable.' }
Write-Output $Installed
