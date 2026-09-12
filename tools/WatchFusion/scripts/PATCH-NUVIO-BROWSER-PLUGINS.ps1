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
  if ($distBundle -notmatch 'cinemeta\.strem\.io\/meta' -and $distBundle -notmatch 'moviedb_id') {
    throw "Built Nuvio bundle is missing browser plugin TMDB resolution."
  }
  Write-Host 'Verified WatchFusion browser plugin bridge in compiled Nuvio dist (v1).'
  exit 0
}

$clientPath = Join-Path $NuvioDir 'js\platform\pluginServiceClient.js'
if (-not (Test-Path -LiteralPath $clientPath)) {
  throw "Nuvio PluginServiceClient source not found: $clientPath"
}

$source = (Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
if (-not ($source.Contains($Marker) -and $source.Contains($FetchMarker))) {
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
}

# 2. Patch TmdbService to resolve IMDb IDs via Cinemeta metadata fallback when no TMDB API key is configured
$tmdbPath = Join-Path $NuvioDir 'js\core\tmdb\tmdbService.js'
if (Test-Path -LiteralPath $tmdbPath) {
  $tmdbSource = (Get-Content -LiteralPath $tmdbPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
  if (-not $tmdbSource.Contains('cinemeta.strem.io')) {
    $tmdbOld = '    if ((requireEnabled && !settings.enabled) || !apiKey) return null;'
    $tmdbNew = @'
    if ((requireEnabled && !settings.enabled) || !apiKey) {
      const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(contentType)}/${encodeURIComponent(parsed.idPart)}.json`;
      const cinemetaRequest = (async () => {
        try {
          const cData = await fetchJson(cinemetaUrl);
          const moviedbId = cData?.meta?.moviedb_id ?? cData?.meta?.moviedbId;
          if (moviedbId != null && /^\d+$/.test(String(moviedbId))) {
            const resolvedId = String(moviedbId);
            imdbToTmdbCache.set(key, resolvedId);
            tmdbToImdbCache.set(lookupKey(resolvedId, contentType), parsed.idPart);
            return resolvedId;
          }
        } catch (_) {}
        return null;
      })();
      imdbToTmdbInFlight.set(key, cinemetaRequest);
      try {
        return await cinemetaRequest;
      } finally {
        if (imdbToTmdbInFlight.get(key) === cinemetaRequest) {
          imdbToTmdbInFlight.delete(key);
        }
      }
    }
'@
    $tmdbNew = $tmdbNew.Replace("`r`n", "`n")
    if ($tmdbSource.Contains($tmdbOld)) {
      $tmdbSource = $tmdbSource.Replace($tmdbOld, $tmdbNew)
      Set-Content -LiteralPath $tmdbPath -Value $tmdbSource -Encoding UTF8
    }
  }
}

# 3. Patch MetaDetailsScreen to extract moviedb_id from Cinemeta metadata
$metaPath = Join-Path $NuvioDir 'js\ui\screens\detail\metaDetailsScreen.js'
if (Test-Path -LiteralPath $metaPath) {
  $metaSource = (Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
  if (-not $metaSource.Contains('meta?.moviedb_id')) {
    $metaOld = "    meta?.external_ids?.tmdb,`n    params?.tmdbId,"
    $metaNew = "    meta?.external_ids?.tmdb,`n    meta?.moviedb_id,`n    meta?.moviedbId,`n    params?.tmdbId,"
    if ($metaSource.Contains($metaOld)) {
      $metaSource = $metaSource.Replace($metaOld, $metaNew)
      Set-Content -LiteralPath $metaPath -Value $metaSource -Encoding UTF8
    }
  }
}

# 4. Patch StreamScreen to forward tmdbId in loadStreams options
$streamScreenPath = Join-Path $NuvioDir 'js\ui\screens\stream\streamScreen.js'
if (Test-Path -LiteralPath $streamScreenPath) {
  $streamScreenSource = (Get-Content -LiteralPath $streamScreenPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
  if (-not $streamScreenSource.Contains('tmdbId: this.params?.tmdbId')) {
    $streamScreenOld = 'itemId: String(this.params?.itemId || ""),'
    $streamScreenNew = "itemId: String(this.params?.itemId || `"`),`n      tmdbId: this.params?.tmdbId || null,"
    if ($streamScreenSource.Contains($streamScreenOld)) {
      $streamScreenSource = $streamScreenSource.Replace($streamScreenOld, $streamScreenNew)
      Set-Content -LiteralPath $streamScreenPath -Value $streamScreenSource -Encoding UTF8
    }
  }
}

# 5. Patch StreamRepository to check options.tmdbId for plugin execution
$streamRepoPath = Join-Path $NuvioDir 'js\data\repository\streamRepository.js'
if (Test-Path -LiteralPath $streamRepoPath) {
  $streamRepoSource = (Get-Content -LiteralPath $streamRepoPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
  if (-not $streamRepoSource.Contains('options?.tmdbId')) {
    $streamRepoOld = 'const tmdbLookupId = localVideoId ? rawVideoId : String(options?.itemId || rawVideoId).trim();'
    $streamRepoNew = 'const tmdbLookupId = localVideoId ? rawVideoId : String(options?.tmdbId || options?.itemId || rawVideoId).trim();'
    if ($streamRepoSource.Contains($streamRepoOld)) {
      $streamRepoSource = $streamRepoSource.Replace($streamRepoOld, $streamRepoNew)
      Set-Content -LiteralPath $streamRepoPath -Value $streamRepoSource -Encoding UTF8
    }
  }
}

Write-Host 'Nuvio browser plugin execution bridged to WatchFusion host-local networking (v1).'
