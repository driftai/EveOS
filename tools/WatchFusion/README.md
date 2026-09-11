# WatchFusion

WatchFusion is a single media application with an optional synchronized watch-party layer. One WatchFusion server and one browser UI handle solo playback first, then promote the current media into a synchronized room when you choose to watch together. It unifies direct media and HLS playback, YouTube iframe integration, external watch-page resolvers, the Nuvio media catalog and addon ecosystem, the VoxelVision 3D media engine, rooms, chat, and real-time WebSocket/SSE synchronization.

WatchFusion now lives canonically inside EveOS at `tools/WatchFusion/`. The retired `Private-Test-Builds/WatchFusion` copy is no longer an authoritative source.

---

## 🌟 Highlights

- **One Unified Boot**: Starting WatchFusion starts the full platform. Nuvio and VoxelVision are mounted inside the same UI; YouTube, direct media, and compatible external sources are loaded from the same source controls.
- **Solo First, Party Optional**: Play media without creating a room. When ready, create a Watch Party and the current source is promoted into synchronized room playback.
- **Synchronized Watch Parties**: Real-time room state with host and viewer synchronization, sub-second drift correction, adaptive playback rate adjustments, synchronized pause/play/seek.
- **Unified Media Architecture**:
  - **YouTube**: Integrated YouTube player with API lifecycle handling and replay loop recovery.
  - **Direct Streams & HLS**: Native HTML5 video and HLS.js streaming with CORS validation and recovery.
  - **Media Resolvers**: Automatic stream discovery for external watch pages and direct media links.
  - **Nuvio Integration**: External-Nuvio integration providing access to Stremio addon catalogs, metadata resolution, and trailer playback.
  - **VoxelVision Integration**: Built-in 3D voxel playback, browser-local AI/luminance depth conversion, analysis caching, local video import, and optional yt-dlp/FFmpeg YouTube ingestion.
- **Cross-Platform & Tunnel Ready**:
  - Localhost (`127.0.0.1`) by default and explicit LAN (`0.0.0.0`) mode with `sslip.io` local canonical DNS mapping.
  - One-click Cloudflare Quick Tunnel deployment (`scripts/START-WATCHFUSION-REMOTE.bat`).
- **Privacy & Security Boundaries**:
  - Host network/setup/Nuvio diagnostics are host-local only.
  - Remote/LAN VoxelVision status redacts CPU, RAM, GPU, and local helper-provider details.
  - Static WatchFusion, Nuvio, and VoxelVision file serving is contained to explicit roots, including real-path checks against traversal/symlink escape.
  - External media/addon requests reject loopback/private-network destinations and revalidate redirects.
  - Public room state uses opaque member identifiers rather than internal account/session IDs.
- **External Nuvio Architecture**:
  - Nuvio is decoupled and installed by the user (`.\nuvio` or custom `NUVIO_PATH`).
  - No Nuvio source/runtime tree is tracked in EveOS Git; `nuvio/.gitkeep` is the placeholder.
- **Modular Design**: Strict $\le 450$ lines per first-party source file architecture.
- **Registry-managed networking**: EveOS owns the canonical service-port map in `../../config/eveos-ports.json`; WatchFusion consumes `WATCHFUSION_PORT` from that registry instead of owning a literal port assignment.

For the detailed threat/containment model and its limitations, see [`SECURITY.md`](SECURITY.md). Third-party/upstream attribution is recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

## 🚀 Quick Start

### 1. Start WatchFusion (the full unified platform)
```cmd
WatchFusion.bat
:: Or directly:
scripts\START-WATCHFUSION-LOCAL.bat
```
The launcher reads `WATCHFUSION_PORT` from EveOS's canonical port registry and opens the complete WatchFusion UI on that port (currently `9087`). You do not start Nuvio, VoxelVision, or WatchParty separately: all three tools plus YouTube/direct media are available from this one application.

### 2. Start WatchFusion on LAN
```cmd
scripts\START-WATCHFUSION-LAN.bat
```
Listens on `0.0.0.0:<WATCHFUSION_PORT>` and generates LAN-accessible IP and `sslip.io` hostnames using the registered port. LAN mode intentionally makes WatchFusion reachable from the local network; use it only on networks you trust.

### 3. Start Cloudflare Remote Tunnel
```cmd
scripts\START-WATCHFUSION-REMOTE.bat
```
The remote launcher passes the same registry-managed port into the local WatchFusion origin and Cloudflare tunnel. Stop the tunnel when the session is finished. A Quick Tunnel URL is a transport address, not an authentication secret.

---

## 📦 Nuvio Integration Setup

WatchFusion supports Nuvio as an external media provider. Earlier WatchFusion documentation referenced `NuvioMedia/NuvioWeb`; the current canonical Smart TV/web source used by WatchFusion setup is [`NuvioMedia/NuvioTVSmart`](https://github.com/NuvioMedia/NuvioTVSmart).

1. **Install Nuvio**:
   ```cmd
   scripts\GET-NUVIO.bat
   ```
2. **Build Nuvio Web Bundle**:
   ```cmd
   scripts\BUILD-NUVIO.bat
   ```
3. **Configure Nuvio Account / QR**:
   ```cmd
   scripts\CONFIGURE-NUVIO.bat
   ```

The installed Nuvio tree remains outside EveOS source tracking and is governed by Nuvio's upstream GPL-3.0 license.

---

## VoxelVision Integration

VoxelVision v1.9.7 is included under `voxelvision/` and mounted by the WatchFusion server at `/voxelvision/`; no second server or build step is required. Choose the **VoxelVision** source tab to open it. Its local video processing and depth caches remain browser-local.

The procedural demo works immediately. YouTube-to-voxel importing is optional and uses the helper binaries in `voxelvision/tools/`. To install or update those helpers, run `voxelvision\VoxelVision.bat` and choose option 4. Downloaded videos stay in the ignored `voxelvision/public/media/imported/` runtime directory.

When a host selects VoxelVision in a room, every participant is moved to the same tool source. VoxelVision's internal editing and playback controls remain local to each participant; WatchFusion does not claim synchronized control over the embedded engine's private state. Host hardware details and host-side YouTube import remain unavailable to remote/LAN WatchFusion viewers.

---

## Privacy Notes For Remote Use

WatchFusion does not intentionally expose arbitrary host files, host filesystem paths, LAN addresses, setup/tool diagnostics, or detailed VoxelVision hardware information to remote room participants. Public media/addon proxying is constrained to validated public HTTP(S) destinations rather than loopback/private-network targets.

There is one intentional network privacy boundary to understand: when WatchFusion proxies supported remote media or addon requests, the **WatchFusion host machine/network is the outbound network egress point**. The public upstream service contacted by WatchFusion can therefore see the host network's public IP address. This is different from exposing private LAN addresses or files to room participants, but it is still observable by the upstream service.

No static review can prove a networked application vulnerability-free. Keep dependencies current, use LAN/tunnel sharing only when intended, and run the security smoke suite after security-sensitive changes.

---

## 🧪 Verification & Smoke Suite

```cmd
npm run --silent test
```
Runs:
1. `scripts/CHECK-ARCHITECTURE.mjs --quiet` (enforces the $\le 450$-line module rule and smoke-output policy)
2. `tests/smoke/run.js --full` (unit, integration, media, Nuvio, VoxelVision, security, and Playwright tests)

Security-only qualification:

```cmd
npm run --silent test:security
```

For ordinary edits, use `npm run --silent test:smoke` or the smallest affected profile. Successful runs print one summary line; failure diagnostics are bounded in the terminal and stored under ignored `test-results/`. The fast profile can reuse an identical content-fingerprinted pass, while deeper and final gates always execute. Do not rerun an unchanged passing suite unless a new change or environment condition gives the rerun a reason.

---

## 📜 Upstream Attribution & Source Layout

WatchFusion consolidates and builds upon:
- **WatchParty**: [`howardchung/watchparty`](https://github.com/howardchung/watchparty) — synchronized watch-together platform, MIT licensed.
- **Nuvio**: [`NuvioMedia/NuvioTVSmart`](https://github.com/NuvioMedia/NuvioTVSmart) — current canonical Nuvio Smart TV/web source used by WatchFusion setup, GPL-3.0 licensed. Older references may use the historical `NuvioMedia/NuvioWeb` URL.
- **VoxelVision**: bundled v1.9.7 source and public-safe procedural demo (3D voxel media and depth-conversion engine).

The live WatchParty-derived core is in `server.js`, `src/`, and `public/`; the Nuvio integration uses the user-installed `nuvio/` tree; and the live VoxelVision source is in `voxelvision/`. WatchFusion has no runtime or test dependency on historical staging copies outside EveOS.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for license/attribution notes.
