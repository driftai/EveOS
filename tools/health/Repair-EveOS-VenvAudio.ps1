# Read-only by default. -RepairCffi is an explicit opt-in binary-wheel repair.
[CmdletBinding()]
param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [switch]$RepairCffi
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$python = Join-Path $repo '.venv\Scripts\python.exe'
$health = Join-Path $repo 'tools\health\eveos_venv_audio_health.py'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$evidence = Join-Path $HOME "Downloads\EveOS-Diagnostics\Venv-Audio-Health\$stamp"
New-Item -Path $evidence -ItemType Directory -Force | Out-Null

if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw "Missing EveOS .venv Python: $python" }
if (!(Test-Path -LiteralPath $health -PathType Leaf)) { throw "Missing health probe: $health" }
Set-Location $repo

# Capture native stdout and stderr independently. PowerShell 5.1 otherwise turns
# legitimate stderr diagnostics into terminating NativeCommandError exceptions.
function Invoke-PythonCaptured([string[]]$PythonArgs, [string]$Stem) {
    $stdout = Join-Path $evidence "$Stem.stdout.txt"
    $stderr = Join-Path $evidence "$Stem.stderr.txt"
    $process = Start-Process -FilePath $python -ArgumentList $PythonArgs `
        -WorkingDirectory $repo -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($null -eq $process -or $null -eq $process.ExitCode) {
        throw "Could not obtain Python exit code for $Stem"
    }
    return [int]$process.ExitCode
}

function Invoke-Health([string]$file) {
    $stem = $file.Replace('.json', '')
    $exitCode = Invoke-PythonCaptured -Stem $stem -PythonArgs @('-B', ('"' + $health + '"'), '--json')
    $stdout = Join-Path $evidence "$stem.stdout.txt"
    $output = Get-Content -LiteralPath $stdout -Raw
    Set-Content -LiteralPath (Join-Path $evidence $file) -Value $output -Encoding UTF8
    try { $parsed = $output | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "Health probe did not produce JSON (exit $exitCode); see $evidence\$stem.stderr.txt" }
    if ($exitCode -ne 0 -and $parsed.status -eq 'PASS') {
        throw "Health probe process exited $exitCode despite PASS. Inspect $evidence"
    }
    return $parsed
}

Write-Host '=== EVEOS .VENV READ-ONLY AUDIO CHECK ===' -ForegroundColor Cyan
$before = Invoke-Health 'before.json'
Write-Host "Status: $($before.status)  Reason: $($before.reason)  Outputs: $($before.playableOutputs)"
Write-Host "Evidence: $evidence"

if ($before.status -eq 'PASS') {
    Write-Host 'EVEOS_VENV_AUDIO_READY_NO_CHANGES' -ForegroundColor Green
    exit 0
}
if (!$RepairCffi) {
    Write-Warning 'No changes performed. Re-run with -RepairCffi only if the CFFI binary import failed.'
    exit 1
}
if ($before.reason -notin @('cffi-backend-import-failed', 'cffi-import-failed')) {
    throw "Repair refused: reason '$($before.reason)' is not a CFFI binary failure."
}

# Do not mutate the environment while an EveOS process could be importing its DLLs.
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $repo '.venv'), [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -match 'eveos-server-launch|eveos_control|audioflix'
    })
if ($running.Count -gt 0) {
    throw "Repair refused: EveOS Python process(es) still running ($($running.ProcessId -join ', ')). Stop them normally, then retry."
}

$versionProbe = @'
from importlib.metadata import version, PackageNotFoundError
try:
    print(version('cffi'))
except PackageNotFoundError:
    print('MISSING')
'@
$version = ($versionProbe | & $python -B - | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect CFFI metadata. Nothing repaired.' }
$requirement = if ($version -eq 'MISSING') { 'cffi==2.1.1' } else { "cffi==$version" }
Write-Host "=== REPAIR VERIFIED CFFI BINARY WHEEL ($requirement) ===" -ForegroundColor Cyan
$pipExit = Invoke-PythonCaptured -Stem 'repair-pip' -PythonArgs @(
    '-m', 'pip', 'install', '--disable-pip-version-check',
    '--only-binary=:all:', '--force-reinstall', $requirement
)
if ($pipExit -ne 0) {
    throw "CFFI wheel repair failed (exit $pipExit). See $evidence\repair-pip.stderr.txt"
}
Write-Host "CFFI wheel repair completed. Pip logs: $evidence" -ForegroundColor Green

$after = Invoke-Health 'after.json'
if ($after.status -ne 'PASS') {
    throw "CFFI repaired but native audio not fully ready ($($after.reason)); inspect $evidence\after.json"
}
Write-Host 'EVEOS_VENV_CFFI_REPAIR_PASS' -ForegroundColor Green
Write-Host 'Restart EveOS via its normal launcher to reload Python imports.'
exit 0
