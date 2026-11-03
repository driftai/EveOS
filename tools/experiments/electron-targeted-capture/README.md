# Experiment E: Electron targeted webContents capture (feasibility spike)

Not production code. Nothing here is wired into EveOS, Nexus, or the managed Spotify Engine.
The Engine stays the default. Do not change Nexus mode selection while running this.

## What it tests
One dedicated **source** webContents (a synthetic tone, or the official Spotify embed) is captured by a
separate, trusted **capture** page. The capture uses `session.setDisplayMediaRequestHandler()` with
`audio: <source WebFrameMain>` and `enableLocalEcho: false`. That combination should mean no picker and no
source speaker output. PCM is forwarded by the **main process** to the existing EveOS renderer
(`POST /api/audioflix/play-pcm`, `strictDevice: true`, renderer-side `gain`).

- Electron is pinned at **45.2.1**. The API was checked against the Electron 45 session docs.
- `WebFrameMain` capture captures the **whole containing webContents**, not one iframe. That's why the
  source window holds nothing except the provider page.
- `audio: 'loopback' | 'loopbackWithMute'` is **system audio** and is never used here. If targeted capture
  fails, report the failure. Do not substitute loopback.
- Voice processing (AEC, NS, AGC) is ON by default for captured audio. The capture page turns it off and
  logs `voice-processing-still-on` if it can't.

## Security boundary
- All windows run with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`.
- Remote Spotify content gets no preload and no Node. Navigation is limited to the local pages plus
  `open.spotify.com`, `accounts.spotify.com`, and `www.spotify.com`. `<webview>` is denied. Popups are
  allowed only for Spotify login.
- Only the capture page's own top frame, on a user gesture, can obtain the grant. Every other
  display-media request, including one from the source, is denied and logged.
- IPC handlers check that the sender is the capture page's main frame. The bridge URL never reaches a renderer.
- The source session allows only `fullscreen` and `mediaKeySystem` (licensed playback). Stock Electron
  ships **no Widevine CDM**, so DRM full tracks may not play. Report that as a finding. Do not work around it.

## Storage (approve before first run)
Everything the spike writes goes under `--data-dir`. The default is `tools/experiments/electron-targeted-capture/.run/`
(gitignored): Electron userData plus `report-<ts>.json`. No audio is ever written. Sessions are in-memory
unless `--persist-spotify` is passed. In that case the Spotify profile lives in the same folder. Delete
`.run/` to clean up.

## Setup (Drift's Windows machine)
```
cd tools/experiments/electron-targeted-capture
npm install
```
This installs into this folder only. Nothing is installed globally and the root package.json is untouched.
Start the EveOS server as usual so `/api/audioflix/play-pcm` is reachable (default `http://127.0.0.1:3000`).

## Run order (stop at the first FAIL)
1. **Synthetic, capture only:** `npx electron . --source=tone --decoy`
   Click **Start capture**. PASS means no picker appears, the log shows `rms ≈ -15 dBFS`, `440Hz` is strong, and `880Hz(decoy)`
   is at least 30 dB lower. You should hear only the decoy (880 Hz), not the 440 Hz source.
2. **Suppression A/B:** `npx electron . --source=tone --local-echo`. Now you SHOULD hear 440 Hz.
   This only proves the contrast. It's never a GO config.
3. **Renderer to CABLE:** `npx electron . --source=tone --decoy --device-id=sd:7`
   Press 100%, 50%, then 0%. For each step, in a second terminal (all other CABLE sources silent):
   `python measure_cable_rms.py --label g100` (then g50, g0). Expect g50 ≈ g100 − 6 dB, g0 at the floor, and
   band880Db at the floor in every step.
4. **Lifecycle:** run Stop, Start, Reload source, Destroy source, and Recreate. After Destroy, the track must end, the
   capture releases itself, and no further PCM arrives (check CABLE RMS). Closing the capture window
   sends `stop-stream` and quits. Capture CPU and memory with the button.
5. **Spotify preview:** `npx electron . --source=spotify --device-id=sd:7` (optionally
   `--spotify-url=https://open.spotify.com/embed/track/<id>`). Press play in the source window.
   Record preview vs full track, pause/resume, track switch, and that the CABLE signal follows the player.
6. **Spotify authenticated (only after 5):** add `--persist-spotify` and sign in through the embed's
   own login. Record whether full tracks play in stock Electron, given there's no Widevine CDM.

## Report back
For each step: PASS/FAIL, the `report-<ts>.json` path, and the physical CABLE measurements, kept
**separately** from automated assertions. Finish with GO / PARTIAL / NO-GO. If NO-GO, name the exact
boundary (grant denied, picker shown, silent capture, echo not suppressed, DRM) and move to the native
process-loopback experiment.

## Sandbox self-test (Vera, Linux ARM64, no audio hardware)
`EVE_SPIKE_SELFTEST_MS=9000 EVE_SPIKE_SELFTEST_GAIN=0.5 EVE_SPIKE_SELFTEST_DESTROY=1 electron . --source=tone --decoy --hide-source --device-id=sd:7 --bridge=http://127.0.0.1:3999 --no-sandbox --ozone-platform=headless --disable-gpu`
This simulates the Start click as a gesture. It is never GO evidence.
