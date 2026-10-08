param(
    [ValidateSet('start','status','stop','auth','qualify')]
    [string]$Action = 'status',
    [string]$BaseUrl = 'http://127.0.0.1:8765',
    [string]$PageUrl = 'http://127.0.0.1:8765/EveOS.html',
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

switch ($Action) {
    'start' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/start' @{ pageUrl = $PageUrl }
        Show-Status $result
        if (-not $result.ok -or -not $result.helperReachable) { throw 'Managed Spotify browser did not become ready.' }
        Write-Host 'Managed Edge is ready. Use the EveOS window that it opened for Spotify playback/volume.'
    }
    'status' {
        $result = Invoke-EveGet '/api/audioflix/spotify-browser/status'
        Show-Status $result
        if (-not $result.ok) { exit 1 }
    }
    'stop' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/stop'
        $result | ConvertTo-Json -Depth 8
    }
    'auth' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/auth' @{ openLogin = $true }
        $result | ConvertTo-Json -Depth 8
        Write-Host 'A Spotify tab was opened inside the managed browser. Sign in there; the persistent Audioflix profile will retain the session.'
    }
    'qualify' {
        $result = Invoke-EvePost '/api/audioflix/spotify-browser/start' @{ pageUrl = $PageUrl }
        Show-Status $result
        if (-not $result.ok) { throw 'Could not start managed Spotify browser.' }
        if (-not $result.nodeAvailable) { throw 'Node.js readiness check failed.' }
        if (-not $result.playwrightAvailable) { throw 'Playwright readiness check failed.' }
        if (-not $result.helperReachable) { throw 'Managed helper connection check failed.' }
        if (-not $result.pageAttached) { throw 'Managed EveOS page is not attached.' }
        if ($RequireSignedIn -and $result.authState -ne 'signed-in') {
            throw "Spotify signed-in state is '$($result.authState)'. Run -Action auth, sign in, then qualify again."
        }
        Write-Host 'QUALIFIER PRECHECK PASS'
        Write-Host 'Now play a Spotify track in the managed EveOS window and run:'
        Write-Host '  node tools/smoke/audioflix_spotify_browser_live_smoke.mjs --require-playing --volume-sweep'
    }
}
