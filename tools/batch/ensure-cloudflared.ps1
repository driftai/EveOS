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

if ($env:EVEOS_CLOUDFLARED -and (Test-Cloudflared $env:EVEOS_CLOUDFLARED)) {
    Write-Output (Resolve-Path -LiteralPath $env:EVEOS_CLOUDFLARED).Path
    exit 0
}

$Command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $Command) { $Command = Get-Command cloudflared -ErrorAction SilentlyContinue }
if ($Command -and (Test-Cloudflared $Command.Source)) {
    Write-Output $Command.Source
    exit 0
}

if (Test-Cloudflared $Destination) {
    Write-Output (Resolve-Path -LiteralPath $Destination).Path
    exit 0
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$Asset = if ($Architecture -in @('x86', 'x86_32')) { 'cloudflared-windows-386.exe' } else { 'cloudflared-windows-amd64.exe' }
$ReleaseApi = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
$Directory = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$Temporary = "$Destination.download"
Remove-Item -Force -LiteralPath $Temporary -ErrorAction SilentlyContinue

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Headers = @{ 'User-Agent' = 'EveOS-cloudflared-bootstrap' }
    $Release = Invoke-RestMethod -Uri $ReleaseApi -Headers $Headers
    $ReleaseAsset = $Release.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
    if (-not $ReleaseAsset.browser_download_url) {
        throw "Official Cloudflare release does not contain $Asset."
    }
    $ChecksumPattern = '(?mi)^\s*' + [regex]::Escape($Asset) + ':\s*([a-f0-9]{64})\s*$'
    $ChecksumMatch = [regex]::Match([string]$Release.body, $ChecksumPattern)
    if (-not $ChecksumMatch.Success) {
        throw "Official Cloudflare release did not publish a SHA256 checksum for $Asset."
    }
    $ExpectedHash = $ChecksumMatch.Groups[1].Value.ToLowerInvariant()
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
    throw "cloudflared is required and automatic download failed: $($_.Exception.Message)"
}

Write-Output (Resolve-Path -LiteralPath $Destination).Path
