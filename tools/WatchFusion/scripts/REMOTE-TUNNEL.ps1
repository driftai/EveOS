param(
    [Parameter(Mandatory=$true)]
    [string]$Root,

    [Parameter(Mandatory=$true)]
    [string]$Cloudflared,

    [Parameter(Mandatory=$true)]
    [ValidateRange(1, 65535)]
    [int]$Port
)

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $Root '.runtime'
$SessionId = [guid]::NewGuid().ToString('N')

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$UrlFile = Join-Path $StateDir 'remote-url.txt'
$PidFile = Join-Path $StateDir 'cloudflared.pid'
$ServerPidFile = Join-Path $StateDir 'server.pid'
$CloudflareLog = Join-Path $StateDir ("cloudflared-{0}.log" -f $SessionId)

function Test-WatchFusion {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -Method Get -TimeoutSec 2
        return ($r.ok -eq $true -and $r.app -eq 'WatchFusion')
    } catch { return $false }
}

function Test-RemoteUrl {
    param([string]$Url)
    try {
        $uri = [Uri]$Url
        [System.Net.Dns]::GetHostAddresses($uri.Host) | Out-Null
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch { return $false }
}

function Get-TunnelUrl {
    if (-not (Test-Path $CloudflareLog)) { return $null }
    $text = Get-Content $CloudflareLog -Raw -ErrorAction SilentlyContinue
    if (-not $text) { return $null }
    $match = [regex]::Match($text, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { return $match.Value }
    return $null
}

function Owns-ActiveTunnelState {
    try {
        return ([int](Get-Content $PidFile -Raw -ErrorAction Stop).Trim()) -eq $Tunnel.Id
    } catch { return $false }
}

function Clear-OwnActiveTunnelState {
    if (-not (Owns-ActiveTunnelState)) { return }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    if (Test-Path $UrlFile) {
        $CurrentUrl = (Get-Content $UrlFile -Raw -ErrorAction SilentlyContinue).Trim()
        if (-not $Url -or $CurrentUrl -eq $Url) {
            Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
        }
    }
}

function Exit-RemoteCancelled {
    param([string]$Message = 'Remote startup cancelled because WatchFusion stopped.')
    Clear-OwnActiveTunnelState
    Write-Host ""
    Write-Host $Message
    Write-Host "Cloudflare tunnel session ended cleanly."
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "Starting WatchFusion for Internet access..."
Write-Host ""

if (Test-WatchFusion) {
    Write-Host "WatchFusion is already running on port $Port. Reusing existing server."
} else {
    Write-Host "Starting WatchFusion origin on localhost:$Port..."
    $ServerCommand = "cd /d `"$Root`" && set HOST=127.0.0.1&& set PORT=$Port&& node server.js"
    $Server = Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"$ServerCommand`"" -WorkingDirectory $Root -PassThru
    $Server.Id | Set-Content -Encoding ASCII $ServerPidFile
    Write-Host "WatchFusion server terminal opened (PID $($Server.Id))."
    Write-Host "Waiting for WatchFusion to become ready..."
    $ServerReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-WatchFusion) { $ServerReady = $true; break }
        if ($Server.HasExited) { throw "WatchFusion server terminal exited before the server became ready." }
        Start-Sleep -Seconds 1
    }
    if (-not $ServerReady) { throw "WatchFusion did not become ready on port $Port." }
    Write-Host "WatchFusion origin is ready."
}

Write-Host ""
Write-Host "Starting Cloudflare Quick Tunnel..."
Write-Host "A separate Cloudflare terminal will remain visible."
Write-Host ""

$TunnelArgs = @(
    'tunnel',
    '--loglevel', 'info',
    '--logfile', $CloudflareLog,
    '--no-autoupdate',
    '--url', "http://127.0.0.1:$Port"
)
$Tunnel = Start-Process -FilePath $Cloudflared -ArgumentList $TunnelArgs -WorkingDirectory $Root -PassThru
$Tunnel.Id | Set-Content -Encoding ASCII $PidFile
Write-Host "Cloudflare tunnel process opened directly (PID $($Tunnel.Id))."
Write-Host "Waiting for Cloudflare to assign a public hostname..."

$Url = $null
$Deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $Deadline) {
    if ($Tunnel.HasExited) {
        if (-not (Test-WatchFusion)) {
            Exit-RemoteCancelled "Remote startup cancelled while waiting for a Cloudflare hostname."
        }
        Write-Host ""
        Write-Host "ERROR: Cloudflare tunnel exited during startup."
        if (Test-Path $CloudflareLog) { Get-Content $CloudflareLog }
        throw "Cloudflare tunnel exited during startup."
    }
    $Url = Get-TunnelUrl
    if ($Url) { break }
    Start-Sleep -Milliseconds 500
}

if (-not $Url) {
    if (-not (Test-WatchFusion)) {
        Exit-RemoteCancelled "Remote startup cancelled before Cloudflare assigned a hostname."
    }
    Write-Host ""
    Write-Host "ERROR: Cloudflare did not provide a public URL within 60 seconds."
    if (Test-Path $CloudflareLog) {
        Write-Host "Cloudflare log:"
        Get-Content $CloudflareLog
    } else { Write-Host "No Cloudflare log was created." }
    throw "Cloudflare tunnel startup failed."
}

$Url | Set-Content -Encoding ASCII $UrlFile
Write-Host ""
Write-Host "Cloudflare assigned:"
Write-Host "    $Url"
Write-Host ""
Write-Host "Waiting for the public hostname to become reachable..."

$Ready = $false
$ReadyDeadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $ReadyDeadline) {
    if ($Tunnel.HasExited) {
        if (-not (Test-WatchFusion)) {
            Exit-RemoteCancelled "Remote startup cancelled while waiting for public readiness."
        }
        throw "Cloudflare tunnel exited while waiting for public readiness."
    }
    if (-not (Test-WatchFusion)) {
        try { Stop-Process -Id $Tunnel.Id -Force -ErrorAction SilentlyContinue } catch {}
        Exit-RemoteCancelled "Remote startup cancelled while waiting for public readiness."
    }
    if (Test-RemoteUrl $Url) { $Ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $Ready) {
    if (-not (Test-WatchFusion)) {
        try { Stop-Process -Id $Tunnel.Id -Force -ErrorAction SilentlyContinue } catch {}
        Exit-RemoteCancelled "Remote startup cancelled before public readiness completed."
    }
    throw "Cloudflare created the hostname but it was not reachable."
}

Write-Host ""
Write-Host "============================================================"
Write-Host "REMOTE WATCHFUSION IS READY"
Write-Host "============================================================"
Write-Host "Remote WatchFusion URL:"
Write-Host "    $Url"
Write-Host "Origin:      http://127.0.0.1:$Port"
Write-Host "Tunnel:      Cloudflare Quick Tunnel"
Write-Host "Status:      CONNECTED"
Write-Host "Tunnel PID:  $($Tunnel.Id)"
Write-Host "============================================================"
Write-Host ""
Write-Host "EveOS stays in its current tab. Use the printed URL on the remote device."
Write-Host "Keep this launcher window open while remote access is needed."
Write-Host ""

$OriginMisses = 0
while (-not $Tunnel.HasExited) {
    Start-Sleep -Seconds 1
    if (Test-WatchFusion) {
        $OriginMisses = 0
        continue
    }
    $OriginMisses += 1
    if ($OriginMisses -lt 3) { continue }

    Write-Host ""
    Write-Host "WatchFusion origin stopped. Closing its Cloudflare tunnel..."
    try { Stop-Process -Id $Tunnel.Id -Force -ErrorAction Stop } catch {}
    try { $Tunnel.WaitForExit(3000) } catch {}
    break
}

Clear-OwnActiveTunnelState
Write-Host ""
Write-Host "Cloudflare tunnel session ended."
Write-Host ""
