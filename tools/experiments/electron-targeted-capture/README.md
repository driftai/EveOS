# Experiment E: Electron targeted webContents capture (feasibility spike)

Not production code. Nothing here is wired into EveOS, Nexus, or the managed Spotify Engine.
The Engine stays the default. Do not change Nexus mode selection while running this.

## What it tests
One dedicated **source** webContents (a synthetic tone, or the official Spotify embed) is captured by a
separate, trusted **capture** page. The capture uses `session.setDisplayMediaRequestHandler()` with
`audio: <source WebFrameMain>` and `enableLocalEcho: false`. That combination should mean no picker and no
source speaker output. PCM is forwarded by the **main process** to the existing EveOS renderer through
the authenticated provider-capture session API on its own **`electron-capture`** lane
(`/api/audioflix/provider-capture/start|chunk|stop`, strict device, renderer-side `gain`).

## Native output ownership (hardening, after the 5d0b7d7c Windows run)
- The original spike posted to `play-pcm` on the shared `primary` lane. `PcmPlayer.enqueue()` clears a lane
  whenever another stream id writes to it, so any other `primary` writer on `sd:7` (Gemini voice, another
  spike process) could silently wipe the spike's queue. That's the likely cause of the intermittent 440 Hz
  dropouts. The spike now has a dedicated lane, so other lanes can no longer preempt it.
- Lanes are separate **queues** on one physical stream, and the renderer sums them. Two sources on one
  endpoint are therefore audible together by design. Test capture isolation upstream (the 440/880 bands in
  the capture log), not as silence at CABLE. Production Spotify should hold exclusive playback ownership
  (Spotify Developer Policy forbids mixing Spotify with other audio).
- Each capture is one native session of one **generation** per host `ownerId`. The server rejects any
  request with a stale owner, generation or lane. A second Electron host can't seize a live lane. It can
  reclaim one only after the old owner has been silent for 4 s (a crashed host).
- Chunks go out strictly one at a time, in order. At most 4 more wait (the oldest is dropped as stale).
  Stop, track end, source destroy, capture-page navigation, renderer crash and window close each retire the
  generation first. Teardown then waits for the in-flight chunk and stops exactly that session, so a late
  chunk can never revive it (the server fences chunk and stop on the same session lock).
- The provider-capture **start** uses the install-local credential in `data/runtime/` (pass
  `--eveos-root=<checkout>` if the spike runs from elsewhere). Main reads it. It never reaches a
  renderer and is never logged.
- The report records ownership transitions (`bridge-session-started/stopped`, `bridge-start-failed`),
  native rejects (first 200, with time), and totals (`sent/failed/stale/retired`, native
  `dropped/underruns/backlogFrames`).

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
- Only the exact trusted document (`pages/capture.html`, no query or fragment) in the capture window's top
  frame, on a user gesture, can obtain the grant. Every other display-media request, including one from
  the source, is denied and logged.
- Privileged IPC checks both the sender frame and its URL. The capture window can't navigate, redirect,
  open popups or attach webviews. Any attempt is blocked and also ends the native session (fail closed:
  press Stop, then Start to resume).
- Local pages are trusted by resolved-path containment in `pages/`, plus an exact list (`tone.html`,
  `capture.html`), never by substring.
- Allowed Spotify login popups inherit the source partition and get the same navigation, popup and
  webview locks, recursively (`did-create-window`).
- Diagnostics redact query strings and fragments (Spotify login codes/state) and local paths.
- The bridge URL, session token and install credential never reach a renderer.
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
Start the EveOS server as usual so `/api/audioflix/provider-capture/*` is reachable (default `http://127.0.0.1:3000`).
The server must include the `electron-capture` lane (this commit or later).

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
   capture releases itself, and no further PCM arrives (check CABLE RMS). Stop (and Destroy) must silence
   CABLE within about 0.5 s, with `bridge-session-stopped` in the report. Closing the window does the same and quits.
   **Collision check:** while 440 Hz runs to `sd:7`, play any other EveOS PCM to `sd:7`. The 440 Hz must
   keep going without gaps. Both are audible together because the lanes mix. Capture CPU and memory with the button.
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

## Tests
- Unit, no Electron: `node --test tools/experiments/electron-targeted-capture/test/spike.test.js`
  (allow-list, exact capture document, redaction, ordered/bounded/fenced bridge).
- Native lane, real player + provider sessions: `python tools/smoke/audioflix_electron_capture_lane_smoke.py`.
  Both run in `npm run smoke:audioflix-provider-capture`.

## Sandbox self-test (Vera, Linux ARM64, no audio hardware)
`EVE_SPIKE_SELFTEST_MS=9000 EVE_SPIKE_SELFTEST_GAIN=0.5 EVE_SPIKE_SELFTEST_DESTROY=1 electron . --source=tone --decoy --hide-source --device-id=sd:7 --eveos-root=<checkout> --no-sandbox --ozone-platform=headless --disable-gpu`
Optional `EVE_SPIKE_SELFTEST_NAV=<url>` tries to navigate the capture window. It simulates the Start click
as a gesture. It is never GO evidence.
