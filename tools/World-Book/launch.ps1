param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8766,
    [ValidateSet('prompt', 'local', 'lan', 'cloudflare')]
    [string]$ExposureMode = 'prompt',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$BootDir = Join-Path $ProjectRoot 'tools\batch'
$StateWriter = Join-Path $BootDir 'set-exposure-state.ps1'
$TunnelLauncher = Join-Path $BootDir 'start-quick-tunnel.ps1'

Remove-Item -LiteralPath "$PSScriptRoot\app\assets\js\app.js" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$PSScriptRoot\app\assets\js\taxonomy.js" -Force -ErrorAction SilentlyContinue
Set-Location $PSScriptRoot

function Resolve-PythonCommand {
    $Venv = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $Venv) { return @{ File = $Venv; Prefix = @() } }
    $Python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Python) { return @{ File = $Python.Source; Prefix = @() } }
    $Py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($Py) { return @{ File = $Py.Source; Prefix = @('-3') } }
    throw 'Python was not found. Install Python 3 and try again.'
}

function Choose-ExposureMode {
    if ($ExposureMode -ne 'prompt') { return $ExposureMode }
    if ($NoBrowser) { return 'local' }
    Write-Host ''
    Write-Host '========================================'
    Write-Host '  Selective Boot - World Book'
    Write-Host '========================================'
    Write-Host '  [1] Localhost only  (default / private)'
    Write-Host '  [2] LAN             (trusted local network)'
    Write-Host '  [3] Cloudflare Router (temporary authenticated URL)'
    Write-Host '  [Q] Cancel'
    while ($true) {
        $choice = (Read-Host 'Select exposure mode').Trim().ToLowerInvariant()
        switch ($choice) {
            '1' { return 'local' }
            '' { return 'local' }
            '2' { return 'lan' }
            '3' { return 'cloudflare' }
            'q' { return 'cancel' }
            default { Write-Host 'Choose 1, 2, 3, or Q.' }
        }
    }
}

function Get-LanAddress {
    $candidate = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
        Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            -not [System.Net.IPAddress]::IsLoopback($_)
        } | Select-Object -First 1
    if ($candidate) { return $candidate.IPAddressToString }
    return 'YOUR-PC-LAN-IP'
}

$Mode = Choose-ExposureMode
if ($Mode -eq 'cancel') { exit 0 }
$Python = Resolve-PythonCommand
$HostAddress = if ($Mode -eq 'lan') { '0.0.0.0' } else { '127.0.0.1' }
$serverArguments = @($Python.Prefix) + @('.\server.py', '--host', $HostAddress, '--port', [string]$Port)
if ($NoBrowser -or $Mode -eq 'cloudflare') { $serverArguments += '--no-browser' }

if ($Mode -eq 'local') {
    & $StateWriter -Service world-book -Mode local -Inactive
    & $Python.File @serverArguments
    exit $LASTEXITCODE
}

if ($Mode -eq 'lan') {
    $LanUrl = "http://$(Get-LanAddress):$Port/"
    & $StateWriter -Service world-book -Mode lan -PublicUrl $LanUrl -OriginUrl "http://127.0.0.1:$Port"
    Write-Host ''
    Write-Host '[WARN] LAN mode exposes the World Book UI and its configured workspace APIs to devices on this local network.' -ForegroundColor Yellow
    Write-Host "[READY] $LanUrl" -ForegroundColor Cyan
    try {
        & $Python.File @serverArguments
        exit $LASTEXITCODE
    } finally {
        & $StateWriter -Service world-book -Mode local -Inactive
    }
}

& $StateWriter -Service world-book -Mode local -Inactive
$OriginArgs = @($Python.Prefix) + @('.\server.py', '--host', '127.0.0.1', '--port', [string]$Port, '--no-browser')
$Origin = Start-Process -FilePath $Python.File -ArgumentList $OriginArgs -WorkingDirectory $PSScriptRoot -PassThru
try {
    $ready = $false
    for ($i = 0; $i -lt 50; $i++) {
        if ($Origin.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
            if ($health.ok -eq $true -and $health.service -eq 'world-book') { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 120
    }
    if (-not $ready) { throw "World Book did not become ready on localhost:$Port." }
    & $TunnelLauncher -Service world-book -OriginPort $Port -PublicPath '/' -OpenBrowser:(!$NoBrowser)
} finally {
    & $StateWriter -Service world-book -Mode local -Inactive
    if ($Origin -and -not $Origin.HasExited) { Stop-Process -Id $Origin.Id -Force -ErrorAction SilentlyContinue }
}
