param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'
$ytDlp = Join-Path $tools 'yt-dlp.exe'
$ffmpeg = Join-Path $tools 'ffmpeg.exe'
$ffprobe = Join-Path $tools 'ffprobe.exe'
$tempZip = Join-Path $tools 'ffmpeg-download.zip'
$tempDir = Join-Path $tools 'ffmpeg-download'

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

Write-Host '[1/2] Installing/updating portable yt-dlp...'
$ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
if ($Force -or -not (Test-Executable -Path $ytDlp -Args @('--version'))) {
  Invoke-WebRequest -UseBasicParsing -Uri $ytDlpUrl -OutFile $ytDlp
}
if (-not (Test-Executable -Path $ytDlp -Args @('--version'))) {
  throw 'yt-dlp.exe was downloaded but did not start successfully.'
}
Write-Host '[OK] yt-dlp.exe is ready.'

Write-Host '[2/2] Installing/updating portable FFmpeg + ffprobe...'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$archiveName = if ($architecture -eq 'arm64') {
  'ffmpeg-master-latest-winarm64-gpl.zip'
} else {
  'ffmpeg-master-latest-win64-gpl.zip'
}
$ffmpegUrl = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/$archiveName"
$needFfmpeg = $Force -or -not (Test-Executable -Path $ffmpeg -Args @('-version')) -or -not (Test-Executable -Path $ffprobe -Args @('-version'))

if ($needFfmpeg) {
  try {
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
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
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
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
