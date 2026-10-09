param(
    [ValidateSet('start','status','stop','auth','qualify')]
    [string]$Action = 'status',
    [string]$BaseUrl = 'http://127.0.0.1:8765',
    [string]$PageUrl = 'http://127.0.0.1:8765/audioflix-spotify-engine.html',
    [ValidateSet('background','window','headless')]
    [string]$Presentation = 'background',
    [switch]$RequireSignedIn
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')

function Invoke-EveGet([string]$Path) {
    Invoke-RestMethod -Method Get -Uri "$base$Path" -TimeoutSec 15
}

function Invoke-EvePost([string]$Path, [hashtable]$Body = @{}) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$base$Path" -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 30
}

function Get-EnginePageUrl([string]$Url, [string]$Mode) {
    $clean = $Url -replace '([?&])playwright=headless(&|$)', '$1'
    $clean = $clean.TrimEnd('?','&')
    if ($Mode -ne 'headless') { return $clean }
    $separator = if ($clean.Contains('?')) { '&' } else { '?' }
    return "${clean}${separator}playwright=headless"
}

function Get-CurrentStatus {
    try { return Invoke-EveGet '/api/audioflix/spotify-browser/status' }
    catch { return $null }
}

function Ensure-EngineRuntimeMode([string]$Mode) {
    $current = Get-CurrentStatus
    if (-not $current -or -not $current.browserRunning) { return }
    $wantHeadless = $Mode -eq 'headless'
    $haveHeadless = [string]$current.browserChannel -like '*-headless'
    if ($wantHeadless -ne $haveHeadless) {
        [void](Invoke-EvePost '/api/audioflix/spotify-browser/stop')
        Start-Sleep -Milliseconds 250
    }
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
    }
}
"@
    }
}

function Set-SpotifyEnginePresentation([string]$Mode) {
    if ($env:OS -ne 'Windows_NT' -or $Mode -eq 'headless') { return $true }
    Ensure-WindowApi
    $deadline = (Get-Date).AddSeconds(5)
    do {
        $windows = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*EveOS Spotify Engine*'
        })
        if ($windows.Count -gt 0) {
            $command = if ($Mode -eq 'background') { 6 } else { 9 }
            foreach ($process in $windows) {
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
        lastError = $Status.lastError
    }
    [pscustomobject]$summary | Format-List
}

function Start-ManagedEngine([string]$Mode) {
    Ensure-EngineRuntimeMode $Mode
    $effectivePageUrl = Get-EnginePageUrl $PageUrl $Mode
    return Invoke-EvePost '/api/audioflix/spotify-browser/start' @{ pageUrl = $effectivePageUrl }
}

switch ($Action) {
    'start' {
        $result = Start-ManagedEngine $Presentation
        Show-Status $result
        if (-not $result.ok -or -not $result.helperReachable) { throw 'Managed Spotify browser did not become ready.' }
        if (-not $result.sessionPresent) { throw 'Managed Spotify browser started without a private server-side helper identity.' }
        [void](Set-SpotifyEnginePresentation $Presentation)
        Write-Host 'Managed Spotify engine is ready.'
        if ($Presentation -eq 'background') {
            Write-Host 'The managed Edge engine was minimized. Use Audioflix Internal View to mirror it inside EveOS.'
        } elseif ($Presentation -eq 'headless') {
            Write-Host 'The managed Spotify engine is running headless with no browser window.'
            Write-Host 'Audible output in true headless mode is browser/OS dependent; use background mode if Windows does not expose audio.'
        } else {
            Write-Host 'The managed Edge engine is visible in its own window.'
        }
        Write-Host 'Use Audioflix from an ordinary localhost EveOS tab, or approve a file:// EveOS tab when prompted.'
    }
    'status' {
        $result = Invoke-EveGet '/api/audioflix/spotify-browser/status'
        Show-Status $result
        if (-not $result.ok) { exit 1 }
        if ($null -ne $result.sessionId) { throw 'Public status must never expose the private helper session id.' }
    }
    'stop' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/stop'
        $result | ConvertTo-Json -Depth 8
    }
    'auth' {
        $current = Get-CurrentStatus
        if ($current -and ([string]$current.browserChannel -like '*-headless')) {
            [void](Invoke-EvePost '/api/audioflix/spotify-browser/stop')
            Start-Sleep -Milliseconds 250
            [void](Invoke-EvePost '/api/audioflix/spotify-browser/start' @{ pageUrl = (Get-EnginePageUrl $PageUrl 'window') })
        }
        [void](Set-SpotifyEnginePresentation 'window')
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/auth' @{ openLogin = $true }
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
        [void](Set-SpotifyEnginePresentation $Presentation)
        Write-Host 'QUALIFIER PRECHECK PASS'
        Write-Host 'Now open Audioflix in an ordinary EveOS tab and play a Spotify track.'
        Write-Host 'For file:// EveOS, approve the matching six-digit code in the trusted localhost approval window.'
        Write-Host 'Then run the live sweep while playback is audible:'
        Write-Host '  node tools/smoke/audioflix_spotify_browser_live_smoke.mjs --require-playing --require-signed-in --volume-sweep'
    }
}
