# WatchFusion

WatchFusion is a single media application with an optional synchronized watch-party layer. One WatchFusion server and one browser UI handle solo playback first, then promote the current media into a synchronized room when you choose to watch together. It unifies direct media and HLS playback, YouTube iframe integration, external watch-page resolvers, the Nuvio media catalog and addon ecosystem, the VoxelVision 3D media engine, rooms, chat, and real-time WebSocket/SSE synchronization.

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
  - Localhost (127.0.0.1) & LAN (0.0.0.0) modes with `sslip.io` local canonical DNS mapping.
  - One-click Cloudflare Quick Tunnel deployment (`scripts/START-WATCHFUSION-REMOTE.bat`).
- **Strict Privacy & Security Hardening**:
  - Loopback-only host network diagnostics (`/api/network-info` is denied over Cloudflare tunnels).
  - Opaque public member IDs and session identity binding in room state.
  - SSRF protection on all external media and addon proxy requests via DNS resolution validation.
  - Sanitized runtime scripts (`window.__NUVIO_ENV__`) with strict key allowlists.
  - Same-origin VoxelVision API enforcement, contained file serving, byte-range media responses, and an iframe-specific CSP.
- **External Nuvio Architecture**:
  - Nuvio is decoupled and installed by the user (`.\nuvio` or custom `NUVIO_PATH`).
  - No bundled Nuvio dependencies in Git; placeholder `.gitkeep` only.
- **Modular Design**: Strict $\le 450$ lines per source file architecture.
- **Registry-managed networking**: EveOS owns the canonical service-port map in `../../config/eveos-ports.json`; WatchFusion consumes `WATCHFUSION_PORT` from that registry instead of owning a literal port assignment.

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
Listens on `0.0.0.0:<WATCHFUSION_PORT>` and generates LAN-accessible IP and `sslip.io` hostnames using the registered port.

### 3. Start Cloudflare Remote Tunnel
```cmd
scripts\START-WATCHFUSION-REMOTE.bat
```
The remote launcher passes the same registry-managed port into the local WatchFusion origin and Cloudflare tunnel.

---

## 📦 Nuvio Integration Setup

WatchFusion supports Nuvio as an external media provider:

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

---

## VoxelVision Integration

VoxelVision v1.9.7 is included under `voxelvision/` and mounted by the WatchFusion server at `/voxelvision/`; no second server or build step is required. Choose the **VoxelVision** source tab to open it. Its local video processing and depth caches remain browser-local.

The procedural demo works immediately. YouTube-to-voxel importing is optional and uses the helper binaries in `voxelvision/tools/`. To install or update those helpers, run `voxelvision\VoxelVision.bat` and choose option 4. Downloaded videos stay in the ignored `voxelvision/public/media/imported/` runtime directory.

When a host selects VoxelVision in a room, every participant is moved to the same tool source. VoxelVision's internal editing and playback controls remain local to each participant; WatchFusion does not claim synchronized control over the embedded engine's private state.

---

## 🧪 Verification & Smoke Suite

```cmd
npm run --silent test
```
Runs:
1. `scripts/CHECK-ARCHITECTURE.mjs --quiet` (enforces the $\le 450$-line module rule and smoke-output policy)
2. `tests/smoke/run.js --full` (unit, integration, media, Nuvio, VoxelVision, security, and Playwright tests)

For ordinary edits, use `npm run --silent test:smoke` or the smallest affected profile. Successful runs print one summary line; failure diagnostics are bounded in the terminal and stored under ignored `test-results/`. The fast profile can reuse an identical content-fingerprinted pass, while deeper and final gates always execute. Do not rerun an unchanged passing suite unless a new change or environment condition gives the rerun a reason.

---

## 📜 Upstream Attribution & Source Layout

WatchFusion consolidates and builds upon:
- **WatchParty**: [https://github.com/howardchung/watchparty](https://github.com/howardchung/watchparty) (Synchronized watch-together platform)
- **Nuvio**: [https://github.com/NuvioMedia/NuvioWeb](https://github.com/NuvioMedia/NuvioWeb) (WebOS media browser & streaming application)
- **VoxelVision**: bundled v1.9.7 source and public-safe procedural demo (3D voxel media and depth-conversion engine)

The live WatchParty core is in `server.js`, `src/`, and `public/`; the Nuvio integration uses the user-installed `nuvio/` tree; and the live VoxelVision source is in `voxelvision/`. WatchFusion has no runtime or test dependency on the historical `original/` snapshots.
