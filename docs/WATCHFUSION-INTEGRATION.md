# WatchFusion in EveOS

WatchFusion is a first-class EveOS workspace with its own media/watch-party runtime.

## Integrated source

The initial WatchFusion merge was hydrated from:

- Repository: `driftai/Private-Test-Builds`
- Path: `WatchFusion/`
- Pinned source commit: `f2f1db5b68d5529100b3ea5ee2007af144575df6`

The integrated source now lives at:

`<EveOS>\tools\WatchFusion`

That EveOS copy is authoritative for integrated development. The standalone checkout may remain as a temporary comparison/backup while qualification is still underway, but runtime code must never depend on it.

## Ownership boundary

EveOS owns:

- Header/workspace entry beside Audioflix.
- EveOS-themed outer workspace chrome and Matrix-style detached-window behavior.
- Embedded layout mode so WatchFusion uses the full EveOS workspace instead of nesting a second desktop-sized card.
- Lifecycle/status integration through the local control plane on registry key `GEMINI_CONTROL_PORT` (currently 9082).
- WatchFusion service ownership and safety checks.
- Explicit/on-demand runtime behavior: opening the workspace never starts WatchFusion.
- Independent headed/headless terminal preference for an explicitly started runtime.
- Fresh-clone repair of WatchFusion's locked Node dependencies.
- Shared smoke-test/output policy and final repository verification.

WatchFusion keeps:

- Node HTTP/WebSocket server on registry key `WATCHFUSION_PORT` (currently 9087).
- Room/host/chat/realtime synchronization.
- YouTube/direct/HLS/Find Media provider behavior.
- Nuvio bridge/injection logic.
- VoxelVision routes and media conversion behavior.
- LAN and Cloudflare-specific runtime behavior.
- Its own focused smoke/browser/integration/security suites.

The current integrated Find Media/media resolver core is intentionally carried forward from the standalone WatchFusion implementation. EveOS-specific setup/lifecycle/security layers are additions around that media core, not replacements for it.

## Canonical service-port registry

`config/eveos-ports.json` is the single source of truth for EveOS-owned service ports. Batch launchers, Python lifecycle modules, and the integrated WatchFusion server resolve their assignments from that registry (with explicit environment overrides allowed for qualification).

The registry is audited for duplicate assignments during `npm run verify`, and the control-plane entrypoint refuses to start when effective environment overrides collide. New tools must register a unique port there rather than hard-coding one in a launcher/client.

This separation fixes the historical collision where Gemini Live WebSocket and WatchFusion both attempted to own port 9085. Gemini keeps 9085/9086; WatchFusion now uses 9087 by default.

## Lifecycle contract: workspace first, runtime on demand

Opening WatchFusion from the EveOS header is a presentation action only. It must not:

- spawn the WatchFusion Node process;
- open a WatchFusion terminal;
- restore a previously running WatchFusion session;
- run `npm ci` automatically.

The stopped workspace remains useful: it can display lifecycle/setup status from EveOS local control and expose explicit setup/start actions. If local control itself is unavailable, the workspace still stays navigable in degraded mode and explains which live actions are inactive rather than surfacing raw browser network errors.

Only an explicit **Start WatchFusion** action launches the WatchFusion runtime. Installing WatchFusion core dependencies also leaves the runtime stopped afterward.

WatchFusion no longer restores a prior desired-running state when the EveOS control plane starts. This prevents a WatchFusion console from appearing merely because the user used WatchFusion in an earlier session.

EveOS manages runtime actions through:

- `GET /api/watchfusion/status`
- `POST /api/watchfusion/setup` — repair WatchFusion core Node dependencies without starting it
- `POST /api/watchfusion/start`
- `POST /api/watchfusion/stop`

The running WatchFusion process is considered valid only when the registered WatchFusion port answers `/api/health` with `ok: true` and `app: "WatchFusion"`.

A different process occupying the registered WatchFusion port is reported as blocked and must never be killed by EveOS.

Closing the WatchFusion workspace does not stop an already-running service. Stop remains explicit, and EveOS global Stop still includes WatchFusion.

## Embedded and detached UI contract

The outer EveOS WatchFusion shell is full-workspace chrome rather than a modal containing another desktop-sized app card.

When WatchFusion is embedded, EveOS loads it with `?eveos=1`. The inner document marks itself `eveos-embedded` and changes geometry only for that mode:

- remove the standalone `max-width` workspace cap;
- remove nested 16:9 constraints from Nuvio/VoxelVision surfaces;
- use the available iframe height;
- flatten the extra inner panel geometry;
- keep Find Media, room controls, status, and party UI usable inside the available workspace.

Standalone WatchFusion keeps its normal standalone responsive layout.

The outer header uses **Detach** rather than **Open separate**. Detach follows the Matrix workspace behavior: one named reusable popup window, screen-aware sizing, focus an existing detached window when available, and close the embedded overlay after a successful detach.

## Fresh-install and Setup Health contract

Machine-local dependencies are deliberately not committed. A clean EveOS checkout must be able to reconstruct them without the standalone WatchFusion folder.

### WatchFusion core

The EveOS WatchFusion shell detects whether `tools/WatchFusion/node_modules` is ready. When the locked Node dependencies are absent, the outer workspace exposes **Install WatchFusion Core**, which runs:

`npm ci --no-audit --no-fund`

against the committed `tools/WatchFusion/package-lock.json`.

This action does not start WatchFusion. The user decides when to launch the runtime.

The stopped outer workspace also reports the machine-level state it can determine without starting WatchFusion: core dependencies, Nuvio source/build, bundled VoxelVision source, VoxelVision YouTube helpers, and the fact that AI models are browser-managed/on-demand.

### Nuvio

Nuvio remains an external/user-installed runtime under ignored `tools/WatchFusion/nuvio/`.

WatchFusion **Setup Health** reports whether Nuvio source and its browser build are ready. Host-local Windows sessions can install or repair it from the UI. The installer:

1. downloads current `NuvioMedia/NuvioTVSmart` main source;
2. validates the expected application layout;
3. applies WatchFusion's browser-pointer compatibility patch;
4. installs Nuvio build dependencies;
5. builds the browser distribution;
6. verifies the compiled pointer bridge.

WatchFusion resolves Nuvio's public backend configuration through the public discovery endpoint when available. `CONFIGURE-NUVIO.bat` remains a manual fallback, not a requirement for the normal fresh-install path. Never store a service-role secret in WatchFusion.

### VoxelVision

VoxelVision source is bundled and version-controlled under `tools/WatchFusion/voxelvision/`; it does not need a separate source installation.

Optional YouTube ingestion helpers are machine-local and ignored under `voxelvision/tools/`. Setup Health installs/repairs:

- official `yt-dlp.exe`;
- a supported JavaScript challenge runtime: existing Node 22+ when available, otherwise portable Deno;
- portable `ffmpeg.exe`;
- portable `ffprobe.exe`.

Setup Health uses the same readiness rule: Node 22+ **or** a working portable Deno satisfies the JavaScript-runtime requirement. A healthy Node 22+ machine must not remain stuck in `Needs setup` just because `deno.exe` is absent.

The same installer is used by the legacy/manual `VoxelVision.bat` setup menu so the UI and command-line paths do not drift apart.

### VoxelVision AI models

Depth and mask model weights are not repository files and should not be copied from an old WatchFusion folder.

They are browser-managed assets downloaded lazily on first use and cached by the browser profile:

- Depth Anything V3 Small: `en970/depth-anything-v3-small-onnx`
- Depth Anything V2 Small: `onnx-community/depth-anything-v2-small-ONNX`
- Optional anime foreground mask: `BritishWerewolf/IS-Net-Anime`

Setup Health reports these as **On demand** until the model has successfully initialized in that browser, then records the last successful ready time. This is readiness history, not a promise that the browser will never evict its cache.

### Installer security

Install actions are host-machine operations and must never be exposed as remote WatchParty controls.

`POST /api/setup/install` is allowed only when all of the following hold:

- the socket is loopback;
- the request Host is a recognized local WatchFusion hostname;
- the request is not Cloudflare-forwarded;
- browser `Origin` / `Sec-Fetch-Site` evidence is local/same-site;
- the host OS is Windows.

LAN/remote users may see setup status, but cannot execute host installers.

## EveOS localhost sensing

The Search Monitor/Gemini Link localhost indicator must describe the EveOS web server actually serving the current page, not assume port 8765.

For any HTTP/HTTPS EveOS page, the control UI forwards the current page port to the local control plane and verifies `/api/status` against the current origin. This includes:

- `http://localhost:<port>`;
- `http://127.0.0.1:<port>`;
- EveOS sslip hosts;
- the LAN address printed by `python-server.py`, such as `http://192.168.x.x:<port>`.

A live EveOS server on port 3000 must therefore not be labeled **Localhost Off** merely because the page was opened through its LAN or sslip address.

## Verification policy

Normal edits should use the smallest relevant profile:

- `npm run --silent test:smoke`
- `npm run --silent test:deep`
- `npm run --silent test:security`

The fast profile may reuse a prior pass only when its content/environment fingerprint is identical. Deep/security/final results are never reused.

Useful focused checks for this integration include:

- `npm run audit:ports`
- `npm run smoke:watchfusion`
- `npm run smoke:watchfusion-security`
- `npm run smoke:control-plane`

`npm run verify` remains the final uncached gate.

Fresh-install qualification should additionally prove that ignored machine-local dependencies can be removed from a test checkout and reconstructed entirely through the EveOS/WatchFusion setup surfaces without consulting the standalone WatchFusion directory.

## Media-link follow-up (2026-09-29)

The Bridge Tools card opens the dedicated WatchFusion popup; it no longer duplicates pairing or folder actions. Standalone companions remain supported from the same canonical source. Generic capture must associate a reporting video frame with its actual parent iframe, never infer a player from the biggest iframe. Without access to embedded video, keep the crop blank and explain the missing access. Optional embedded-player access remains an explicit browser permission, not an automatic grant. See [Chrome scripting permissions](https://developer.chrome.com/docs/extensions/reference/api/scripting).

Extension folders remain host-local capabilities. The known embedded/detached WatchFusion window may request either fixed package through the protected Local Control route. LAN/viewer pages cannot use that route as filesystem authority. Restart Local Control after Python changes; the launcher clears other services' desired-state files, so do not use it for a no-side-effect restart. In its existing terminal, stop only Local Control with Ctrl+C and rerun `python -u server/eveos-control-helper.py 9082` from the repository. Refresh EveOS/WatchFusion and reload each installed unpacked extension afterward.

Manual qualification: verify both compact folder buttons, Local/LAN/Remote header, Audioflix connect/disconnect, tab link/unlink, and unload. On a non-YouTube source, explicitly enable embedded-player access if needed, connect from the source tab, then verify video-only capture, duration/seek/play controls, scrolling, and frame reloads. Isolated Chromium fixtures are not native Edge/Miruro proof.

The full WatchFusion gate exposed obsolete drift assertions left behind by `715568f9` (which intentionally removed speed chasing), and a wrapper-local Nuvio close state that was overwritten by room renders. The regression cases now prove filtered phase correction without speed changes and preserve local close/reopen intent without changing the shared source. Installed Nuvio source is untouched.

The final repository gate also exposed a protocol-fixture hang: native terminal discovery exhausted a WebSocket message deadline under full-suite load, then HTTP cleanup waited forever for the failed test's upgraded socket. The online protocol fixture now isolates native discovery, registers handshake listeners before dispatch, and terminates its own sockets on failure. Native-target contracts and live services remain unchanged; the full Nexus integration gate passed after this correction.

Remaining Eve-first investigation: Drift reports the phone milliseconds ahead of the laptop during an Audioflix room stream, with built-in audio (no Bluetooth reported). The source tap and duplicate-speaker mute already work; do not redo those or the UI/crop corrections. `browser-extension/live-peer.js` currently creates independent receiver peers without a common acoustic playout schedule. Measure both devices' inbound audio stats and output path before choosing buffering or a synchronization design. W3C defines average jitter-buffer delay from deltas of `jitterBufferDelay / jitterBufferEmittedCount`; its `jitterBufferTarget` is a hint, not exact device synchronization ([WebRTC](https://www.w3.org/TR/webrtc/), [stats](https://www.w3.org/TR/webrtc-stats/)). No guessed global delay has been applied. Preserve host-only source control, viewer isolation, Listen here default, mute leases, and source-owned timeline. Continue on `eve/nexus-machine-spaces`; return exact SHA and bounded phone/laptop validation commands, without deploying Nexus or changing main.
