# WatchFusion in EveOS

WatchFusion is a first-class EveOS workspace with its own media/watch-party runtime.

## Integrated source

The initial WatchFusion merge was hydrated from:

- Repository: `driftai/Private-Test-Builds`
- Path: `WatchFusion/`
- Pinned source commit: `f2f1db5b68d5529100b3ea5ee2007af144575df6`

The integrated source now lives at:

`<EveOS>\tools\WatchFusion`

That EveOS copy is authoritative for integrated development. The old standalone checkout is not a runtime dependency and may be removed once any desired machine-local data has been backed up.

## Ownership boundary

EveOS owns:

- Header/workspace entry beside Audioflix.
- EveOS-themed outer workspace chrome.
- Lifecycle/status integration through the local control plane on port 9082.
- WatchFusion service ownership and safety checks.
- Desired-running restore state.
- Independent headed/headless terminal preference.
- Fresh-clone repair of WatchFusion's locked Node dependencies.
- Shared smoke-test/output policy.
- Final repository verification.

WatchFusion keeps:

- Node HTTP/WebSocket server on port 9085.
- Room/host/chat/realtime synchronization.
- YouTube/direct/HLS/media provider behavior.
- Nuvio bridge/injection logic.
- VoxelVision routes and media conversion behavior.
- LAN and Cloudflare-specific runtime behavior.
- Its own focused smoke/browser/integration/security suites.

## Fresh-install and Setup Health contract

Machine-local dependencies are deliberately not committed. A clean EveOS checkout must be able to reconstruct them without the retired standalone WatchFusion folder.

### WatchFusion core

The EveOS WatchFusion shell detects whether `tools/WatchFusion/node_modules` is ready. When the locked Node dependencies are absent, the outer workspace exposes **Install WatchFusion Core**, which runs:

`npm ci --no-audit --no-fund`

against the committed `tools/WatchFusion/package-lock.json`.

The inner WatchFusion UI becomes available only after the core runtime can start.

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

## UI integration

The EveOS outer WatchFusion workspace consumes EveOS theme tokens. The integrated WatchFusion interior has also been adapted to EveOS's dark/cyan design language while preserving player geometry, pointer/focus behavior, responsive layouts, and black media surfaces where video fidelity requires them.

Because WatchFusion is served from port 9085, its interior theme belongs in the integrated WatchFusion source rather than being injected from the EveOS parent document.

## Lifecycle contract

EveOS manages WatchFusion through:

- `GET /api/watchfusion/status`
- `POST /api/watchfusion/setup` — repair WatchFusion core Node dependencies
- `POST /api/watchfusion/start`
- `POST /api/watchfusion/stop`

The running WatchFusion process is considered valid only when `http://127.0.0.1:9085/api/health` returns `ok: true` and `app: "WatchFusion"`.

A different process occupying 9085 is reported as blocked and must never be killed by EveOS.

Once WatchFusion is running, its internal setup surface uses:

- `GET /api/setup/status`
- `POST /api/setup/install`

Closing the workspace does not stop the service; Stop is explicit, and EveOS global Stop also includes WatchFusion.

## Verification policy

Normal edits should use the smallest relevant profile:

- `npm run --silent test:smoke`
- `npm run --silent test:deep`
- `npm run --silent test:security`

The fast profile may reuse a prior pass only when its content/environment fingerprint is identical. Deep/security/final results are never reused.

`npm run verify` remains the final uncached gate.

`npm run smoke:watchfusion` validates the EveOS integration and invokes WatchFusion's own quiet fast smoke suite when its local dependencies are present. `npm run smoke:watchfusion-security` similarly invokes WatchFusion's security suite.

Fresh-install qualification should additionally prove that ignored machine-local dependencies can be removed from a test checkout and reconstructed entirely through the EveOS/WatchFusion setup surfaces without consulting the old standalone WatchFusion directory.
