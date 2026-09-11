param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'
$ytDlp = Join-Path $tools 'yt-dlp.exe'
$deno = Join-Path $tools 'deno.exe'
$ffmpeg = Join-Path $tools 'ffmpeg.exe'
$ffprobe = Join-Path $tools 'ffprobe.exe'
$tempZip = Join-Path $tools 'helper-download.zip'
$tempDir = Join-Path $tools 'helper-download'

New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Test-Executable {
  param([string]$Path, [string[]]$Args)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $process = Start-Process -FilePath $Path -ArgumentList $Args -NoNewWindow -PassThru -Wait
    return $process.ExitCode -eq 0
  } catch {
    return $false
  }
}

function Reset-Temp {
  if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}

function Get-NodeMajor {
  try {
    $version = (& node --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)') { return [int]$Matches[1] }
  } catch {}
  return 0
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$isArm64 = $architecture -eq 'arm64'
$nodeMajor = Get-NodeMajor

Write-Host '[1/3] Installing/updating official yt-dlp.exe...'
$ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
if ($Force -or -not (Test-Executable -Path $ytDlp -Args @('--version'))) {
  Invoke-WebRequest -UseBasicParsing -Uri $ytDlpUrl -OutFile $ytDlp
}
if (-not (Test-Executable -Path $ytDlp -Args @('--version'))) {
  throw 'yt-dlp.exe was downloaded but did not start successfully.'
}
Write-Host '[OK] yt-dlp.exe is ready (official executable includes yt-dlp EJS scripts).'

Write-Host '[2/3] Checking YouTube JavaScript challenge runtime...'
if ($nodeMajor -ge 22) {
  Write-Host "[OK] Node.js $nodeMajor is supported by current yt-dlp EJS; no Deno download is required."
} else {
  Write-Host "Node.js 22+ is not available (detected major: $nodeMajor). Installing portable Deno fallback..."
  $denoArchive = if ($isArm64) { 'deno-aarch64-pc-windows-msvc.zip' } else { 'deno-x86_64-pc-windows-msvc.zip' }
  $denoUrl = "https://github.com/denoland/deno/releases/latest/download/$denoArchive"
  if ($Force -or -not (Test-Executable -Path $deno -Args @('--version'))) {
    try {
      Reset-Temp
      Invoke-WebRequest -UseBasicParsing -Uri $denoUrl -OutFile $tempZip
      Expand-Archive -LiteralPath $tempZip -DestinationPath $tempDir -Force
      $downloadedDeno = Get-ChildItem -LiteralPath $tempDir -Recurse -Filter 'deno.exe' | Select-Object -First 1
      if (-not $downloadedDeno) { throw 'Deno archive did not contain deno.exe.' }
      Copy-Item -LiteralPath $downloadedDeno.FullName -Destination $deno -Force
    } finally {
      Reset-Temp
    }
  }
  if (-not (Test-Executable -Path $deno -Args @('--version'))) {
    throw 'Node.js is below 22 and portable Deno is unavailable. YouTube EJS challenges cannot run.'
  }
  Write-Host '[OK] Portable Deno is ready for yt-dlp EJS challenge solving.'
}

Write-Host '[3/3] Installing/updating portable FFmpeg + ffprobe...'
$archiveName = if ($isArm64) {
  'ffmpeg-master-latest-winarm64-gpl.zip'
} else {
  'ffmpeg-master-latest-win64-gpl.zip'
}
$ffmpegUrl = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/$archiveName"
$needFfmpeg = $Force -or -not (Test-Executable -Path $ffmpeg -Args @('-version')) -or -not (Test-Executable -Path $ffprobe -Args @('-version'))

if ($needFfmpeg) {
  try {
    Reset-Temp
    Invoke-WebRequest -UseBasicParsing -Uri $ffmpegUrl -OutFile $tempZip
    Expand-Archive -LiteralPath $tempZip -DestinationPath $tempDir -Force
    $downloadedFfmpeg = Get-ChildItem -LiteralPath $tempDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $downloadedFfprobe = Get-ChildItem -LiteralPath $tempDir -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
    if (-not $downloadedFfmpeg -or -not $downloadedFfprobe) {
      throw 'FFmpeg archive did not contain ffmpeg.exe and ffprobe.exe.'
    }
    Copy-Item -LiteralPath $downloadedFfmpeg.FullName -Destination $ffmpeg -Force
    Copy-Item -LiteralPath $downloadedFfprobe.FullName -Destination $ffprobe -Force
  } finally {
    Reset-Temp
  }
}

if (-not (Test-Executable -Path $ffmpeg -Args @('-version'))) {
  throw 'Portable ffmpeg.exe is unavailable after setup.'
}
if (-not (Test-Executable -Path $ffprobe -Args @('-version'))) {
  throw 'Portable ffprobe.exe is unavailable after setup.'
}

Write-Host '[OK] FFmpeg and ffprobe are ready.'
Write-Host 'VOXELVISION_YOUTUBE_SETUP_OK'
