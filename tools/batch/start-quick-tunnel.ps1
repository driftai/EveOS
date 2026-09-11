param(
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][int]$OriginPort,
    [string]$PublicPath = '/',
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$StateWriter = Join-Path $PSScriptRoot 'set-exposure-state.ps1'
$RouterScript = Join-Path $PSScriptRoot 'eveos-secure-share.py'
$RuntimeDir = Join-Path $Root 'data\runtime\selective-boot'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

function Resolve-Python {
    if ($env:EVEOS_PYTHON -and (Test-Path -LiteralPath $env:EVEOS_PYTHON)) {
        return @{ exe = $env:EVEOS_PYTHON; prefix = @() }
    }
    $Venv = Join-Path $Root '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $Venv) { return @{ exe = $Venv; prefix = @() } }
    $Python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Python) { return @{ exe = $Python.Source; prefix = @() } }
    $Py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($Py) { return @{ exe = $Py.Source; prefix = @('-3') } }
    throw 'Python 3 was not found. Start EveOS once or install Python first.'
}

function Resolve-Cloudflared {
    if ($env:EVEOS_CLOUDFLARED -and (Test-Path -LiteralPath $env:EVEOS_CLOUDFLARED)) {
        return $env:EVEOS_CLOUDFLARED
    }
    $Command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if (-not $Command) { $Command = Get-Command cloudflared -ErrorAction SilentlyContinue }
    if ($Command) { return $Command.Source }
    $Bundled = Join-Path $Root 'tools\WatchFusion\tools\cloudflared.exe'
    if (Test-Path -LiteralPath $Bundled) { return $Bundled }
    throw 'cloudflared was not found. Install it or place cloudflared.exe under tools\WatchFusion\tools\.'
}

function Get-FreeLoopbackPort {
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $Listener.Start()
    try { return ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port }
    finally { $Listener.Stop() }
}

function New-AccessToken {
    $Bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($Bytes)
    return ([Convert]::ToHexString($Bytes)).ToLowerInvariant()
}

$Python = Resolve-Python
$Cloudflared = Resolve-Cloudflared
$RouterPort = Get-FreeLoopbackPort
$Token = New-AccessToken
$Origin = "http://127.0.0.1:$OriginPort"
$SafeService = ($Service.ToLowerInvariant() -replace '[^a-z0-9_-]', '')
$RouterOut = Join-Path $RuntimeDir "$SafeService-router.out.log"
$RouterErr = Join-Path $RuntimeDir "$SafeService-router.err.log"
$RouterArgs = @($Python.prefix) + @(
    '-u', $RouterScript,
    '--origin', $Origin,
    '--listen-port', [string]$RouterPort,
    '--token', $Token,
    '--service', $SafeService
)

$Router = Start-Process -FilePath $Python.exe -ArgumentList $RouterArgs -WorkingDirectory $Root `
    -RedirectStandardOutput $RouterOut -RedirectStandardError $RouterErr -PassThru -WindowStyle Hidden

try {
    $Ready = $false
    for ($i = 0; $i -lt 50; $i++) {
        if ($Router.HasExited) { break }
        try {
            $Probe = Invoke-RestMethod -Uri "http://127.0.0.1:$RouterPort/__eveos_share_health" -TimeoutSec 1
            if ($Probe.ok) { $Ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 100
    }
    if (-not $Ready) {
        $Detail = if (Test-Path $RouterErr) { (Get-Content $RouterErr -Tail 10) -join "`n" } else { '' }
        throw "Secure share router did not become ready. $Detail"
    }

    Write-Host ''
    Write-Host '========================================'
    Write-Host "  EveOS Cloudflare Router - $Service"
    Write-Host '========================================'
    Write-Host "  Local origin: $Origin"
    Write-Host "  Auth router:  http://127.0.0.1:$RouterPort"
    Write-Host '  Waiting for temporary trycloudflare.com URL...'
    Write-Host ''

    $PublicUrl = ''
    & $Cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$RouterPort" 2>&1 | ForEach-Object {
        $Line = $_.ToString()
        Write-Host $Line
        if (-not $PublicUrl -and $Line -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
            $Base = $Matches[0].TrimEnd('/')
            $Path = if ($PublicPath.StartsWith('/')) { $PublicPath } else { "/$PublicPath" }
            $Separator = if ($Path.Contains('?')) { '&' } else { '?' }
            $PublicUrl = "$Base$Path$Separator" + 'access=' + $Token
            & $StateWriter -Service $SafeService -Mode cloudflare -PublicUrl $PublicUrl `
                -OriginUrl $Origin -RouterPort $RouterPort
            Write-Host ''
            Write-Host '[READY] Temporary authenticated share:' -ForegroundColor Green
            Write-Host "  $PublicUrl" -ForegroundColor Cyan
            Write-Host ''
            Write-Host 'The origin remains on 127.0.0.1. The access token is converted to an HttpOnly cookie by the local router.'
            Write-Host 'Treat the full URL like a temporary password. Stop this terminal to stop the share.'
            if ($OpenBrowser) { Start-Process $PublicUrl }
        }
    }
}
finally {
    & $StateWriter -Service $SafeService -Mode local -Inactive
    if ($Router -and -not $Router.HasExited) {
        Stop-Process -Id $Router.Id -Force -ErrorAction SilentlyContinue
    }
}
