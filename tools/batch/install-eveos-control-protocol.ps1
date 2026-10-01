param(
    [switch]$Remove,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcher = Join-Path $projectRoot 'tools\batch\eveos-control-protocol.bat'
$windowlessLauncher = Join-Path $projectRoot 'tools\batch\eveos-control-protocol.vbs'
$schemeRoot = 'HKCU:\Software\Classes\eveos-control'

if ($Remove) {
    if (Test-Path -LiteralPath $schemeRoot) {
        Remove-Item -LiteralPath $schemeRoot -Recurse -Force
    }
    if (-not $Quiet) {
        Write-Host 'Removed the EveOS local-control protocol for this Windows user.'
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Protocol launcher not found: $launcher"
}
if (-not (Test-Path -LiteralPath $windowlessLauncher)) {
    throw "Windowless protocol launcher not found: $windowlessLauncher"
}

$commandKey = Join-Path $schemeRoot 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $schemeRoot -Value 'URL:EveOS Local Control'
New-ItemProperty -Path $schemeRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

# The URI argument is deliberately omitted. A web page can request startup, but it
# cannot inject command-line data into the fixed EveOS launcher.
#
# Use wscript for the disposable protocol bootstrap so refreshing file:// EveOS does
# not leave an empty cmd.exe/Windows Terminal window behind. The real Local Control
# process keeps its own visible, titled console when headed mode is enabled.
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$command = ('"{0}" "{1}"' -f $wscript, $windowlessLauncher)
Set-Item -Path $commandKey -Value $command

if (-not $Quiet) {
    Write-Host 'Registered eveos-control:// for this Windows user.'
    Write-Host "Bootstrap: $windowlessLauncher"
    Write-Host "Launcher: $launcher"
}
