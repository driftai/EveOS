param(
    [Parameter(Mandatory=$true)]
    [string]$Root,

    [Parameter(Mandatory=$true)]
    [string]$Cloudflared
)

$ErrorActionPreference = 'Stop'

$Port = 9085
$StateDir = Join-Path $Root '.runtime'

# Fresh state for every Remote [3] session.
Remove-Item $StateDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$UrlFile = Join-Path $StateDir 'remote-url.txt'
$PidFile = Join-Path $StateDir 'cloudflared.pid'
$ServerPidFile = Join-Path $StateDir 'server.pid'
$CloudflareBat = Join-Path $StateDir 'RUN-CLOUDFLARE.bat'
$CloudflareLog = Join-Path $StateDir 'cloudflared.log'

function Test-WatchFusion {
    try {
        $r = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port/" `
            -UseBasicParsing `
            -TimeoutSec 2

        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

function Test-RemoteUrl {
    param([string]$Url)

    try {
        $uri = [Uri]$Url
        [System.Net.Dns]::GetHostAddresses($uri.Host) | Out-Null

        $r = Invoke-WebRequest `
            -Uri $Url `
            -UseBasicParsing `
            -TimeoutSec 5

        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

function Get-TunnelUrl {
    if (-not (Test-Path $CloudflareLog)) {
        return $null
    }

    $text = Get-Content $CloudflareLog -Raw -ErrorAction SilentlyContinue

    if (-not $text) {
        return $null
    }

    $match = [regex]::Match(
        $text,
        'https://[a-zA-Z0-9-]+\.trycloudflare\.com'
    )

    if ($match.Success) {
        return $match.Value
    }

    return $null
}

Write-Host ""
Write-Host "Starting WatchFusion for Internet access..."
Write-Host ""

# =========================================================
# WATCHPARTY SERVER
# =========================================================

if (Test-WatchFusion) {
    Write-Host "WatchFusion is already running on port $Port. Reusing existing server."
}
else {
    Write-Host "Starting WatchFusion origin on localhost:$Port..."

    $ServerCommand = "cd /d `"$Root`" && node server.js"

    $Server = Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList "/k `"$ServerCommand`"" `
        -WorkingDirectory $Root `
        -PassThru

    $Server.Id | Set-Content -Encoding ASCII $ServerPidFile

    Write-Host "WatchFusion server terminal opened (PID $($Server.Id))."
    Write-Host "Waiting for WatchFusion to become ready..."

    $ServerReady = $false

    for ($i = 0; $i -lt 30; $i++) {
        if (Test-WatchFusion) {
            $ServerReady = $true
            break
        }

        if ($Server.HasExited) {
            throw "WatchFusion server terminal exited before the server became ready."
        }

        Start-Sleep -Seconds 1
    }

    if (-not $ServerReady) {
        throw "WatchFusion did not become ready on port $Port."
    }

    Write-Host "WatchFusion origin is ready."
}

# =========================================================
# VISIBLE CLOUDFLARE TERMINAL
# =========================================================

Write-Host ""
Write-Host "Starting Cloudflare Quick Tunnel..."
Write-Host "A separate Cloudflare terminal will remain visible."
Write-Host ""

$CloudflaredPath = $Cloudflared.Replace('"','""')
$LogPath = $CloudflareLog.Replace('"','""')

@"
@echo off
title WatchFusion Cloudflare Quick Tunnel

echo ============================================================
echo              WATCHPARTY CLOUDFLARE TUNNEL
echo ============================================================
echo.
echo Starting:
echo $Cloudflared
echo.
echo Origin:
echo http://127.0.0.1:$Port
echo.
echo ============================================================
echo.

"$CloudflaredPath" tunnel --loglevel info --logfile "$LogPath" --no-autoupdate --url http://127.0.0.1:$Port

echo.
echo ============================================================
echo Cloudflare tunnel process has stopped.
echo ============================================================
echo.
pause
"@ | Set-Content -Encoding ASCII $CloudflareBat

$Tunnel = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList "/k `"$CloudflareBat`"" `
    -WorkingDirectory $Root `
    -PassThru

$Tunnel.Id | Set-Content -Encoding ASCII $PidFile

Write-Host "Cloudflare terminal opened (PID $($Tunnel.Id))."
Write-Host "Waiting for Cloudflare to assign a public hostname..."

# =========================================================
# WAIT FOR URL
# =========================================================

$Url = $null
$Deadline = (Get-Date).AddSeconds(60)

while ((Get-Date) -lt $Deadline) {

    if ($Tunnel.HasExited) {
        Write-Host ""
        Write-Host "ERROR: Cloudflare terminal exited during startup."
        Write-Host ""

        if (Test-Path $CloudflareLog) {
            Get-Content $CloudflareLog
        }

        throw "Cloudflare tunnel exited during startup."
    }

    $Url = Get-TunnelUrl

    if ($Url) {
        break
    }

    Start-Sleep -Milliseconds 500
}

if (-not $Url) {
    Write-Host ""
    Write-Host "ERROR: Cloudflare did not provide a public URL within 60 seconds."
    Write-Host ""

    if (Test-Path $CloudflareLog) {
        Write-Host "Cloudflare log:"
        Get-Content $CloudflareLog
    }
    else {
        Write-Host "No Cloudflare log was created."
    }

    throw "Cloudflare tunnel startup failed."
}

$Url | Set-Content -Encoding ASCII $UrlFile

Write-Host ""
Write-Host "Cloudflare assigned:"
Write-Host ""
Write-Host "    $Url"
Write-Host ""
Write-Host "Waiting for the public hostname to become reachable..."

# =========================================================
# PUBLIC READINESS
# =========================================================

$Ready = $false
$ReadyDeadline = (Get-Date).AddSeconds(60)

while ((Get-Date) -lt $ReadyDeadline) {

    if ($Tunnel.HasExited) {
        throw "Cloudflare terminal exited while waiting for public readiness."
    }

    if (Test-RemoteUrl $Url) {
        $Ready = $true
        break
    }

    Start-Sleep -Seconds 1
}

if (-not $Ready) {
    throw "Cloudflare created the hostname but it was not reachable."
}

# =========================================================
# READY
# =========================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "REMOTE WATCHFUSION IS READY"
Write-Host "============================================================"
Write-Host ""
Write-Host "Remote WatchFusion URL:"
Write-Host ""
Write-Host "    $Url"
Write-Host ""
Write-Host "Origin:      http://127.0.0.1:$Port"
Write-Host "Tunnel:      Cloudflare Quick Tunnel"
Write-Host "Status:      CONNECTED"
Write-Host "Tunnel PID:  $($Tunnel.Id)"
Write-Host ""
Write-Host "============================================================"
Write-Host ""
Write-Host "WatchFusion server terminal: VISIBLE"
Write-Host "Cloudflare terminal:        VISIBLE"
Write-Host ""
Write-Host "Opening Remote WatchFusion..."
Write-Host ""

Start-Process $Url

Write-Host "Remote session active."
Write-Host "Keep this launcher window open while remote access is needed."
Write-Host ""

while (-not $Tunnel.HasExited) {
    Start-Sleep -Seconds 2
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
Remove-Item $CloudflareBat -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Cloudflare tunnel session ended."
Write-Host ""
