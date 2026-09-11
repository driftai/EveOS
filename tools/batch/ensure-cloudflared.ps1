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
$Url = "https://github.com/cloudflare/cloudflared/releases/latest/download/$Asset"
$Directory = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$Temporary = "$Destination.download"
Remove-Item -Force -LiteralPath $Temporary -ErrorAction SilentlyContinue

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Temporary -UseBasicParsing
    if (-not (Test-Cloudflared $Temporary)) {
        throw 'Downloaded cloudflared executable did not pass its version self-check.'
    }
    Move-Item -Force -LiteralPath $Temporary -Destination $Destination
} catch {
    Remove-Item -Force -LiteralPath $Temporary -ErrorAction SilentlyContinue
    throw "cloudflared is required and automatic download failed: $($_.Exception.Message)"
}

Write-Output (Resolve-Path -LiteralPath $Destination).Path
