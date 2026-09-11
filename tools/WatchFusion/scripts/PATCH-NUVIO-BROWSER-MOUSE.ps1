param(
  [Parameter(Mandatory = $true)]
  [string]$NuvioDir,
  [switch]$VerifyDist
)

$ErrorActionPreference = 'Stop'
$NuvioDir = [System.IO.Path]::GetFullPath($NuvioDir)

if ($VerifyDist) {
  $distIndexPath = Join-Path $NuvioDir 'dist\index.html'
  $distBundlePath = Join-Path $NuvioDir 'dist\app.bundle.js'
  if (-not (Test-Path -LiteralPath $distIndexPath) -or -not (Test-Path -LiteralPath $distBundlePath)) {
    throw "Nuvio browser build is missing dist/index.html or dist/app.bundle.js."
  }
  $distIndex = Get-Content -LiteralPath $distIndexPath -Raw -Encoding UTF8
  $distBundle = Get-Content -LiteralPath $distBundlePath -Raw -Encoding UTF8
  if ($distIndex -notmatch '__NUVIO_BROWSER_POINTER__\s*=\s*true' -or
      $distIndex -notmatch '__WATCHFUSION_NUVIO_MOUSE_VERSION__\s*=\s*6') {
    throw "Built Nuvio index is missing WatchFusion browser pointer bootstrap v6."
  }
  if ($distBundle -notmatch '__WATCHFUSION_NUVIO_POINTER_API__' -or
      $distBundle -notmatch 'resumePauseOverlay') {
    throw "Built Nuvio bundle is missing the WatchFusion pointer gateway v6."
  }
  Write-Host 'Verified Nuvio browser pointer gateway in compiled dist (v6).'
  exit 0
}

$focusPath = Join-Path $NuvioDir 'js\ui\navigation\focusEngine.js'
$indexPath = Join-Path $NuvioDir 'index.html'

if (-not (Test-Path -LiteralPath $focusPath)) {
  throw "Nuvio FocusEngine source not found: $focusPath"
}
if (-not (Test-Path -LiteralPath $indexPath)) {
  throw "Nuvio index.html not found: $indexPath"
}

$focus = Get-Content -LiteralPath $focusPath -Raw -Encoding UTF8
$helper = @'
function watchFusionBrowserPointerEnabled(event = null, kind = "") {
  if (event && kind && globalThis?.__NUVIO_BROWSER_POINTER__) {
    try {
      event[kind === "click" ? "__watchFusionNuvioClickHandled" : "__watchFusionNuvioMoveHandled"] = true;
    } catch (_) {}
  }
  return Platform.isWebOS() || Boolean(globalThis?.__NUVIO_BROWSER_POINTER__);
}

function installWatchFusionPointerApi(focusEngine) {
  if (!globalThis?.__NUVIO_BROWSER_POINTER__ || !focusEngine) {
    return;
  }
  globalThis.__WATCHFUSION_NUVIO_POINTER_API__ = {
    version: 6,
    move: (event) => focusEngine.handlePointerMove(event),
    click: (event) => focusEngine.handlePointerClick(event),
    wake: (event) => {
      const screen = Router.getCurrentScreen();
      const target = event?.target;
      const container = screen?.container;
      if (!target || !(container instanceof HTMLElement) || !container.contains(target)) {
        return false;
      }
      if (screen?.isExternalFrameMode?.()) {
        return false;
      }
      if (!screen.controlsVisible && typeof screen?.setControlsVisible === "function") {
        screen.setControlsVisible(true, { focus: false });
      } else {
        screen?.resetControlsAutoHide?.();
      }
      return true;
    },
    resumePauseOverlay: (event) => {
      const screen = Router.getCurrentScreen();
      const target = event?.target;
      const container = screen?.container;
      const overlay = screen?.uiRefs?.pauseOverlay || container?.querySelector?.("#playerPauseOverlay");
      if (!target || !(container instanceof HTMLElement) || !container.contains(target)) {
        return false;
      }
      if (
        !overlay ||
        !screen?.pauseOverlayVisible ||
        !screen?.paused ||
        screen?.stillWatchingPromptVisible ||
        (target !== overlay && !overlay.contains(target))
      ) {
        return false;
      }
      screen.dismissPauseOverlay?.();
      screen.togglePause?.({ focusControls: true });
      screen.renderControlButtons?.();
      return true;
    },
    status: () => ({
      version: 6,
      enabled: watchFusionBrowserPointerEnabled(),
      screen: Router.getCurrentScreen()?.constructor?.name || ""
    })
  };
}

'@

# Accept clean upstream source as well as every earlier WatchFusion patch.
$focus = $focus.Replace('browserPointerEnabled()', 'watchFusionBrowserPointerEnabled()')
$helperBlockPattern = '(?ms)^function\s+watchFusionBrowserPointerEnabled\s*\([^)]*\)\s*\{.*?(?=^function\s+hasActiveModal\s*\()'
if ([regex]::IsMatch($focus, $helperBlockPattern)) {
  $focus = [regex]::Replace($focus, $helperBlockPattern, $helper)
} else {
  $needle = 'function hasActiveModal() {'
  if (-not $focus.Contains($needle)) {
    throw "Unable to locate the FocusEngine helper insertion point."
  }
  $focus = $focus.Replace($needle, $helper + $needle)
}

# Match by pointer-listener/method structure rather than exact upstream spacing.
# There are two independent mouse-move gates in Nuvio; both must be patched.
$initPattern = '(?m)^(?<indent>[ \t]*)if\s*\([^\r\n]*\)\s*\{\r?\n(?=[ \t]*document\.addEventListener\(["'']mousemove["''])'
$movePattern = '(?m)^(?<head>[ \t]*handlePointerMove\s*\(\s*event\s*\)\s*\{\r?\n)(?<indent>[ \t]*)if\s*\([^\r\n]*\)\s*\{'
$processPattern = '(?m)^(?<head>[ \t]*processPointerMove\s*\(\s*event\s*\)\s*\{\r?\n)(?<indent>[ \t]*)if\s*\([^\r\n]*\)\s*\{'
$clickPattern = '(?m)^(?<head>[ \t]*(?:async\s+)?handlePointerClick\s*\(\s*event\s*\)\s*\{\r?\n)(?<indent>[ \t]*)if\s*\([^\r\n]*\)\s*\{'

$initMatches = [regex]::Matches($focus, $initPattern).Count
$moveMatches = [regex]::Matches($focus, $movePattern).Count
$processMatches = [regex]::Matches($focus, $processPattern).Count
$clickMatches = [regex]::Matches($focus, $clickPattern).Count

if ($initMatches -ne 1 -or $moveMatches -ne 1 -or $processMatches -ne 1 -or $clickMatches -ne 1) {
  throw "Nuvio FocusEngine layout unsupported (init=$initMatches move=$moveMatches process=$processMatches click=$clickMatches)."
}

$focus = [regex]::Replace(
  $focus,
  $initPattern,
  '${indent}if (watchFusionBrowserPointerEnabled()) {' + "`r`n"
)
$focus = [regex]::Replace(
  $focus,
  $movePattern,
  '${head}${indent}if (!watchFusionBrowserPointerEnabled(event, "move")) {'
)
$focus = [regex]::Replace(
  $focus,
  $processPattern,
  '${head}${indent}if (!watchFusionBrowserPointerEnabled()) {'
)
$focus = [regex]::Replace(
  $focus,
  $clickPattern,
  '${head}${indent}if (!watchFusionBrowserPointerEnabled(event, "click")) {'
)

if ($focus -notmatch 'installWatchFusionPointerApi\s*\(\s*this\s*\)') {
  $apiAnchorPattern = '(?m)^(?<indent>[ \t]*)this\.boundHandlePointerClick\s*=\s*this\.handlePointerClick\.bind\(this\);\r?\n'
  $apiAnchor = [regex]::Match($focus, $apiAnchorPattern)
  if (-not $apiAnchor.Success) {
    throw "Unable to locate the FocusEngine pointer gateway insertion point."
  }
  $apiCall = $apiAnchor.Value + $apiAnchor.Groups['indent'].Value + 'installWatchFusionPointerApi(this);' + "`r`n"
  $focus = $focus.Remove($apiAnchor.Index, $apiAnchor.Length).Insert($apiAnchor.Index, $apiCall)
}

$positiveCount = [regex]::Matches(
  $focus,
  'if\s*\(\s*watchFusionBrowserPointerEnabled\(\)\s*\)\s*\{'
).Count
$negativeCount = [regex]::Matches(
  $focus,
  'if\s*\(\s*!watchFusionBrowserPointerEnabled\('
).Count
if ($positiveCount -lt 1 -or $negativeCount -lt 3 -or
    $focus -notmatch 'watchFusionBrowserPointerEnabled\(event,\s*["'']move["'']\)' -or
    $focus -notmatch 'watchFusionBrowserPointerEnabled\(event,\s*["'']click["'']\)' -or
    $focus -notmatch '__WATCHFUSION_NUVIO_POINTER_API__' -or
    $focus -notmatch 'resumePauseOverlay') {
  throw "Nuvio FocusEngine patch verification failed (positive=$positiveCount negative=$negativeCount)."
}
Set-Content -LiteralPath $focusPath -Value $focus -Encoding UTF8

$index = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
if ($index -notmatch '__WATCHFUSION_NUVIO_MOUSE_VERSION__') {
  $markerPattern = '(?m)^(?<indent>[ \t]*)<script\s+src=["'']assets/runtime/legacy-features\.js["'']></script>'
  $markerMatch = [regex]::Match($index, $markerPattern)
  if (-not $markerMatch.Success) {
    throw "Unable to locate the Nuvio bootstrap insertion point."
  }
  $bootstrap = @'
    <script>
      (function enableWatchFusionBrowserPointerMode() {
        var root = typeof globalThis !== "undefined" ? globalThis : window;
        root.__NUVIO_BROWSER_POINTER__ = true;
        root.__WATCHFUSION_NUVIO_MOUSE_VERSION__ = 6;
      })();
    </script>
'@
  $index = $index.Insert(
    $markerMatch.Index + $markerMatch.Length,
    "`r`n" + $bootstrap.TrimEnd()
  )
} else {
  $index = [regex]::Replace(
    $index,
    '__WATCHFUSION_NUVIO_MOUSE_VERSION__\s*=\s*\d+',
    '__WATCHFUSION_NUVIO_MOUSE_VERSION__ = 6'
  )
  if ($index -notmatch '__NUVIO_BROWSER_POINTER__\s*=\s*true') {
    throw "Existing WatchFusion bootstrap is missing the browser-pointer flag."
  }
}
Set-Content -LiteralPath $indexPath -Value $index -Encoding UTF8

Write-Host 'Nuvio native browser mouse support enabled (WatchFusion bridge v6).'
