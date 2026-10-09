param(
    [ValidateSet('start','status','stop','auth','qualify')]
    [string]$Action = 'status',
    [string]$BaseUrl = 'http://127.0.0.1:8765',
    [string]$PageUrl = 'http://127.0.0.1:8765/audioflix-spotify-engine.html',
    [ValidateSet('background','hidden','window','headless')]
    [string]$Presentation = 'hidden',
    [switch]$RequireSignedIn
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
$windowStateDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EveOS'
$windowStatePath = Join-Path $windowStateDir 'spotify-engine-window-handle.txt'

function Invoke-EveGet([string]$Path) {
    Invoke-RestMethod -Method Get -Uri "$base$Path" -TimeoutSec 15
}

function Invoke-EvePost([string]$Path, [hashtable]$Body = @{}) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$base$Path" -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 30
}

function Get-CurrentStatus {
    try { return Invoke-EveGet '/api/audioflix/spotify-browser/status' }
    catch { return $null }
}

function Ensure-WindowApi {
    if (-not ('EveOS.Audioflix.WindowApi' -as [type])) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace EveOS.Audioflix {
    public static class WindowApi {
        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);
    }
}
"@
    }
}

function Save-SpotifyEngineWindowHandle([IntPtr]$Handle) {
    try {
        New-Item -ItemType Directory -Path $windowStateDir -Force | Out-Null
        [Int64]$Handle | Set-Content -LiteralPath $windowStatePath -Encoding ascii -NoNewline
    } catch {}
}

function Get-SavedSpotifyEngineWindowHandle {
    if (-not (Test-Path -LiteralPath $windowStatePath)) { return [IntPtr]::Zero }
    try {
        $raw = [Int64](Get-Content -LiteralPath $windowStatePath -Raw)
        $handle = [IntPtr]$raw
        if ($handle -ne [IntPtr]::Zero -and [EveOS.Audioflix.WindowApi]::IsWindow($handle)) { return $handle }
    } catch {}
    Remove-Item -LiteralPath $windowStatePath -Force -ErrorAction SilentlyContinue
    return [IntPtr]::Zero
}

function Set-SpotifyEnginePresentation([string]$Mode) {
    if ($env:OS -ne 'Windows_NT' -or $Mode -eq 'headless') { return $true }
    Ensure-WindowApi
    $command = switch ($Mode) {
        'hidden' { 0 }
        'background' { 6 }
        default { 9 }
    }

    $saved = Get-SavedSpotifyEngineWindowHandle
    if ($saved -ne [IntPtr]::Zero) {
        [void][EveOS.Audioflix.WindowApi]::ShowWindowAsync($saved, $command)
        return $true
    }

    $deadline = (Get-Date).AddSeconds(5)
    do {
        $windows = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*EveOS Spotify Engine*'
        })
        if ($windows.Count -gt 0) {
            foreach ($process in $windows) {
                Save-SpotifyEngineWindowHandle ([IntPtr]$process.MainWindowHandle)
                [void][EveOS.Audioflix.WindowApi]::ShowWindowAsync($process.MainWindowHandle, $command)
            }
            return $true
        }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    Write-Warning 'Could not find the EveOS Spotify Engine window. Playback can still be healthy; use -Action status to inspect it.'
    return $false
}

function Show-Status($Status) {
    $summary = [ordered]@{
        ok = $Status.ok
        nodeAvailable = $Status.nodeAvailable
        playwrightAvailable = $Status.playwrightAvailable
        playwrightVersion = $Status.playwrightVersion
        browserRunning = $Status.browserRunning
        helperReachable = $Status.helperReachable
        state = $Status.state
        authState = $Status.authState
        pageAttached = $Status.pageAttached
        sessionPresent = $Status.sessionPresent
        spotifyFrameCount = $Status.spotifyFrameCount
        mediaCount = $Status.mediaCount
        playingCount = $Status.playingCount
        desiredVolume = $Status.desiredVolume
        profileHasState = $Status.profileHasState
        profileBusy = $Status.profileBusy
        browserChannel = $Status.browserChannel
        presentation = $Status.presentation
        lastError = $Status.lastError
    }
    [pscustomobject]$summary | Format-List
}

function Start-ManagedEngine([string]$Mode) {
    return Invoke-EvePost '/api/audioflix/spotify-browser/presentation' @{
        mode = $Mode
        pageUrl = $PageUrl
    }
}

function Apply-LocalPresentationFallback($Result, [string]$Mode) {
    if ($Mode -eq 'headless' -or $env:OS -ne 'Windows_NT') { return }
    if ($Result.windowFound -eq $true) { return }
    [void](Set-SpotifyEnginePresentation $Mode)
}

switch ($Action) {
    'start' {
        $result = Start-ManagedEngine $Presentation
        Show-Status $result
        if (-not $result.ok -or -not $result.helperReachable) { throw 'Managed Spotify browser did not become ready.' }
        if (-not $result.sessionPresent) { throw 'Managed Spotify browser started without a private server-side helper identity.' }
        Apply-LocalPresentationFallback $result $Presentation
        Write-Host 'Managed Spotify engine is ready.'
        if ($Presentation -eq 'background') {
            Write-Host 'The managed Edge engine was minimized. Use Audioflix Internal View to mirror it inside EveOS.'
        } elseif ($Presentation -eq 'hidden') {
            Write-Host 'The managed Edge engine is headed but hidden from the desktop so Windows audio can remain available.'
            Write-Host 'Use Audioflix Internal View to mirror playback state inside EveOS.'
        } elseif ($Presentation -eq 'headless') {
            Write-Host 'The managed Spotify engine is running headless with no browser window.'
            Write-Host 'True headless mode carries control/state only on systems where the browser exposes no audible output.'
        } else {
            Write-Host 'The managed Edge engine is visible in its own window.'
        }
        Write-Host 'Use Audioflix from an ordinary localhost EveOS tab, or approve a file:// EveOS tab when prompted.'
    }
    'status' {
        $result = Get-CurrentStatus
        Show-Status $result
        if (-not $result.ok) { exit 1 }
        if ($null -ne $result.sessionId) { throw 'Public status must never expose the private helper session id.' }
    }
    'stop' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/stop'
        Remove-Item -LiteralPath $windowStatePath -Force -ErrorAction SilentlyContinue
        $result | ConvertTo-Json -Depth 8
    }
    'auth' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/auth' @{ openLogin = $true; pageUrl = $PageUrl }
        Apply-LocalPresentationFallback $result 'window'
        $result | ConvertTo-Json -Depth 8
        Write-Host 'The managed Edge window was restored for Spotify sign-in. The persistent Audioflix profile will retain the session.'
    }
    'qualify' {
        $result = Start-ManagedEngine $Presentation
        Show-Status $result
        if (-not $result.ok) { throw 'Could not start managed Spotify browser.' }
        if (-not $result.nodeAvailable) { throw 'Node.js readiness check failed.' }
        if (-not $result.playwrightAvailable) { throw 'Playwright readiness check failed.' }
        if (-not $result.helperReachable) { throw 'Managed helper connection check failed.' }
        if (-not $result.pageAttached) { throw 'Managed Spotify engine page is not attached.' }
        if (-not $result.sessionPresent) { throw 'Private helper identity is not active.' }
        if ($null -ne $result.sessionId) { throw 'Public start/status response leaked the private helper session id.' }
        if ($RequireSignedIn -and $result.authState -ne 'signed-in') {
            throw "Spotify signed-in state is '$($result.authState)'. Run -Action auth, sign in, then qualify again."
        }
        Apply-LocalPresentationFallback $result $Presentation
        Write-Host 'QUALIFIER PRECHECK PASS'
        Write-Host 'Now open Audioflix in an ordinary EveOS tab and play a Spotify track.'
        Write-Host 'For file:// EveOS, approve the matching six-digit code in the trusted localhost approval window.'
        Write-Host 'Then run the live sweep while playback is audible:'
        Write-Host '  node tools/smoke/audioflix_spotify_browser_live_smoke.mjs --require-playing --require-signed-in --volume-sweep'
    }
}
