@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo ============================================================
echo         WatchFusion - Nuvio Account & QR Setup
echo ============================================================
echo The public Nuvio key is client configuration.
echo Never enter a service-role secret.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "
$path = Join-Path (Get-Location) 'nuvio-wrapper.properties'
$url = Read-Host 'Backend URL [https://api.nuvio.tv]'
if (-not $url) { $url = 'https://api.nuvio.tv' }

Write-Host 'Querying backend for public discovery key...'
$key = ''
try {
  $r = Invoke-RestMethod -Uri ($url.TrimEnd('/') + '/.well-known/nuvio') -TimeoutSec 5
  if ($r.publishable_key) {
    $key = $r.publishable_key
    Write-Host \"Discovered public key automatically: $key\"
  }
} catch {
  Write-Host 'Discovery endpoint did not return a key.'
}

if (-not $key) {
  $key = Read-Host 'Nuvio publishable/anon key'
}

$tvLogin = Read-Host 'TV login web base URL [https://nuvio.tv/tv-login]'
if (-not $tvLogin) { $tvLogin = 'https://nuvio.tv/tv-login' }

$content = @(
  \"NUVIO_SUPABASE_URL=$url\",
  \"NUVIO_SUPABASE_ANON_KEY=$key\",
  \"TV_LOGIN_WEB_BASE_URL=$tvLogin\",
  \"YOUTUBE_PROXY_URL=youtube-proxy.html\"
) -join \"`n\"

Set-Content -Path $path -Value $content -Encoding utf8
Write-Host \"Saved configuration to: $path\"
"

echo.
echo Configuration complete.
exit /b 0
