# EveOS Playwright qualification — permanent development convention

Owner: EveOS development workflow. Retained in the repository so future agents can follow the same tests rather than relying on chat context.

## Current local browser automation

- The `tools/smoke/playwright-browser.js` helper launches Playwright's `chromium` with `{ headless: true }` by default. It also supports configured browser channels (including Edge), executable paths, and explicit CDP connections; see the helper for allowed environment variable names.
- `tools/WatchFusion/playwright.config.js` runs Playwright browser specs against a disposable localhost WatchFusion server, with one worker and headless Chromium. The WatchFusion package uses its own Playwright dependency, which can require a different browser revision from the root EveOS package.
- Actual browser availability is a **machine dependency**, not committed source. The Chromium headless-shell binary is normally under `%LOCALAPPDATA%\ms-playwright`. To install the WatchFusion shell using that package's CLI: `tools\WatchFusion\node_modules\.bin\playwright.cmd install --only-shell chromium`. Do not copy binaries between revisions. `PLAYWRIGHT_SKIP_BROWSER_GC=1` may be used while installing to avoid pruning existing browser builds.
- Playwright is a real browser automation layer for DOM visibility, clicks, source tabs, iframes, UI queue changes, and lifecycle. Node/VM tests are separate and still required. A green headless UI smoke is not proof of live streaming, real phone sync, Spotify Widevine/DRM playback, Windows audio routing, or provider login.

## Commands and source of truth

Run from the EveOS root in Windows PowerShell:

```powershell
# Focused AudioFlix browser behavior (disposable Chromium session)
node tools/smoke/audioflix_spotify_browser_smoke.js

# Spotify's full focused regression family
npm.cmd run --silent smoke:audioflix-spotify

# WatchFusion full suite including Playwright browser specs
npm.cmd --prefix tools/WatchFusion run --silent test

# Mandatory EveOS release verification before publication
npm.cmd run --silent verify
```

- On the currently installed Playwright 1.62.1 (WatchFusion) and root legacy version, use the supported CSS `:visible` pseudo-class or scope a locator to its active panel if a selector matches hidden duplicate controls. The newer `locator.visible()` helper was introduced after 1.62.1 and must not be assumed available yet. Assert that the intended visible target is unique; never add `force: true` or change tests to quietly skip an interaction.
- Browser spec owners: `tools/WatchFusion/tests/smoke/browser/`; AudioFlix smoke owners: `tools/smoke/`. Keep valid assertions about current semantics (managed Spotify mirror is not the retired legacy Internal Player; successful YouTube loads may close Find Media while it remains reopenable).
- Store generated receipts, logs, and diagnostic exports under `C:\Users\alvin\Downloads\EveOS-Diagnostics`. A project's framework-controlled temporary `test-results` and Playwright's browser cache are permissible but are **not** the durable diagnostic archive.
- Never bypass repository hooks, full release gates, or source-scope guards for publication. Real WatchFusion LAN/phone acceptance additionally requires an owner-authorized extension site permission and a genuine phone viewer session.

## Scope and longevity

This document and the Playwright test/config/source files are version-controlled. Future agents should read them. Package versions, cached binaries and behavior still need re-verification on a new computer, after package updates, or when browsers are reinstalled. This convention does **not** depend on ChatGPT's saved memory or on a separately installed Playwright skill/plugin.
