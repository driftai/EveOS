param(
  [Parameter(Mandatory = $true)]
  [string]$NuvioDir,
  [switch]$VerifyDist
)

$ErrorActionPreference = 'Stop'
$NuvioDir = [System.IO.Path]::GetFullPath($NuvioDir)
$Marker = 'watchFusionBrowserBridge: "v1"'
$FetchMarker = '__WATCHFUSION_NUVIO_PLUGIN_FETCH__'

if ($VerifyDist) {
  $distBundlePath = Join-Path $NuvioDir 'dist\app.bundle.js'
  if (-not (Test-Path -LiteralPath $distBundlePath)) {
    throw "Nuvio browser build is missing dist/app.bundle.js."
  }
  $distBundle = Get-Content -LiteralPath $distBundlePath -Raw -Encoding UTF8
  if ($distBundle -notmatch 'watchFusionBrowserBridge' -or
      $distBundle -notmatch '__WATCHFUSION_NUVIO_PLUGIN_FETCH__') {
    throw "Built Nuvio bundle is missing the WatchFusion browser plugin bridge v1."
  }
  Write-Host 'Verified WatchFusion browser plugin bridge in compiled Nuvio dist (v1).'
  exit 0
}

$clientPath = Join-Path $NuvioDir 'js\platform\pluginServiceClient.js'
if (-not (Test-Path -LiteralPath $clientPath)) {
  throw "Nuvio PluginServiceClient source not found: $clientPath"
}

$source = (Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
if ($source.Contains($Marker) -and $source.Contains($FetchMarker)) {
  Write-Host 'WatchFusion browser plugin bridge already enabled (v1).'
  exit 0
}

$healthOld = @'
    if (!service) {
      cachedHealth = {
        returnValue: globalThis.__NUVIO_ALLOW_BROWSER_PLUGIN_RUNTIME__ === true,
        status:
          globalThis.__NUVIO_ALLOW_BROWSER_PLUGIN_RUNTIME__ === true ? "browser" : "unsupported",
        detail: "No packaged TV plugin service"
      };
      cachedHealthAt = now;
      return cachedHealth;
    }
'@
$healthOld = $healthOld.Replace("`r`n", "`n")
$healthNew = @'
    if (!service) {
      const watchFusionBrowserRuntime =
        Platform.isBrowser() &&
        globalThis.__NUVIO_ALLOW_BROWSER_PLUGIN_RUNTIME__ === true &&
        typeof globalThis.__WATCHFUSION_NUVIO_PLUGIN_FETCH__ === "function";
      cachedHealth = watchFusionBrowserRuntime
        ? {
            returnValue: true,
            status: "browser",
            detail: "WatchFusion local browser plugin bridge",
            protocolVersion: PLUGIN_PROTOCOL_VERSION,
            serviceVersion: 1,
            runtimeVersion: "watchfusion-browser",
            quickjsVersion: "worker-self-test",
            workerSupport: typeof globalThis.Worker === "function",
            maxConcurrency: 10,
            memoryTier: "browser",
            jsPluginCapability: true,
            networkBoundary: true,
            watchFusionBrowserBridge: "v1"
          }
        : {
            returnValue: false,
            status: "unsupported",
            detail: "No packaged TV plugin service"
          };
      cachedHealthAt = now;
      return cachedHealth;
    }
'@
$healthNew = $healthNew.Replace("`r`n", "`n")

if (-not $source.Contains($healthOld)) {
  throw 'Nuvio PluginServiceClient browser health layout changed; refusing an unsafe patch.'
}
$source = $source.Replace($healthOld, $healthNew)

$fetchOld = @'
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const abort = () => controller?.abort();
'@
$fetchOld = $fetchOld.Replace("`r`n", "`n")
$fetchNew = @'
  const watchFusionFetch = globalThis.__WATCHFUSION_NUVIO_PLUGIN_FETCH__;
  if (
    globalThis.__NUVIO_ALLOW_BROWSER_PLUGIN_RUNTIME__ === true &&
    typeof watchFusionFetch === "function"
  ) {
    const bridged = await watchFusionFetch({
      url: validation.url,
      method: validation.method,
      headers: normalizePluginHeaders(validation.headers),
      body: ["POST", "PUT"].includes(validation.method) ? validation.body : "",
      timeoutMs: Number(request.timeoutMs || 30000),
      maxResponseBytes: Number(request.maxResponseBytes || request.maxBodyBytes || 1024 * 1024),
      signal: request.signal
    });
    return normalizeResponse(bridged, validation.url);
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const abort = () => controller?.abort();
'@
$fetchNew = $fetchNew.Replace("`r`n", "`n")

if (-not $source.Contains($fetchOld)) {
  throw 'Nuvio direct browser fetch layout changed; refusing an unsafe patch.'
}
$source = $source.Replace($fetchOld, $fetchNew)

if (-not $source.Contains($Marker) -or -not $source.Contains($FetchMarker)) {
  throw 'WatchFusion browser plugin bridge source verification failed.'
}
Set-Content -LiteralPath $clientPath -Value $source -Encoding UTF8
Write-Host 'Nuvio browser plugin execution bridged to WatchFusion host-local networking (v1).'
