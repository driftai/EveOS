# VoxelVision

VoxelVision is a local-first 3D voxel video engine and audio-reactive media lab. It turns ordinary video into an interactive, depth-aware voxel relief in Three.js, with live browser inference, analyze-ahead caching, temporal stabilization, and reusable conversion profiles.

**Current release:** v1.9.7

> VoxelVision began as an evolution of Joey Cato's original VoxelTV experience. Visit the original [VoxelTV “Take On Me” demo](https://voxeltv.surge.sh/#take-on-me-aha). The public VoxelVision distribution uses its own procedural demo and does not redistribute the original music video or its depth data.

## What It Does

- Converts local videos and supported YouTube sources into GPU-instanced voxel geometry.
- Uses Enhanced Depth Anything V3 or Balanced Depth Anything V2 for relative monocular depth.
- Preserves live depth as `Float32` and persistent cache frames as compact 16-bit depth.
- Fuses model depth with bounded video-edge evidence to improve object boundaries without deriving geometry from brightness alone.
- Stabilizes relative depth over time, detects scene cuts, limits unsupported panel tilt and repairs suspicious border walls.
- Recovers bounded foreground details such as illustrated hair, headwear, and other thin structures when model evidence supports them.
- Interpolates cached depth against decoded video presentation timestamps for smoother playback.

v1.9.7 keeps startup and cached-video restoration responsive. Completed assisted caches no longer compile either AI model just to replay, unfinished assisted work starts the depth and mask models sequentially, and the cache library creates profile controls only when their group is opened. During unavoidable WebGPU model compilation, VoxelVision temporarily lowers display-side GPU pressure and automatically restores full render quality afterward.

v1.9.6 repairs ONNX Runtime execution-provider loading under the local server's Content Security Policy, so DA3/DA2 WebGPU and WASM workers can initialize normally. YouTube share URLs are keyed by canonical video ID, making different `?si=` links for the same video reuse one cache. AI initialization failures are also retryable on a new source instead of becoming sticky for the rest of the tab.

Playback now commits one seek per scrub gesture, pauses new background decoder seeks during scrubbing, and can reload the same local media after a bounded playback failure without importing YouTube again. Range serving handles suffix requests and cancelled streams. Cached endpoints are no longer relifted using another timestamp's image, combined geometric corrections share one displacement budget, and stationary pixels can recover from an initially incorrect height.

v1.9.5 added explicit **AI + decoded video**, **AI model only**, and **Local luminance** conversion paths. Cache replay is not gated by a fresh AI-model startup, and quality scoring samples the depth actually presented by Final Render Depth against the matching decoded color frames.

## Current v1.9.7 Workflow

### Selectable conversion paths

- **AI + decoded video** keeps AI near/far semantics while decoded video guides bounded boundaries, motion alignment, and interpolation.
- **AI model only** keeps decoded color out of geometry conditioning and render fusion while retaining it for display and quality assessment.
- **Local luminance depth** runs entirely in the browser without an AI-model download. It is useful for fast, deterministic conversion and as an explicit alternative when AI is unavailable.

Each path has a distinct cache identity. Legacy cache descriptors remain readable and restore their historical mode.

### Optional anime foreground assistance

In **AI + decoded video**, choose **Foreground Mask Assistance → Anime foreground** to use the optional IS-Net-Anime silhouette model. First use downloads about 176 MB. Its worker runs independently of rendering and the depth worker. Unchanged regions can reuse recent masks; meaningful motion requests a new mask. It adds analysis time (roughly 200–240 ms per warm mask on the development machine), so leave it off for the fastest conversion.

Masks constrain connected foreground membership; nearby model-depth anchors supply the heights. This improves some illuminated hair/head-detail misses but remains experimental: soft masks and monocular depth can still miss difficult scenes. Assistance does not run in model-only or local-luminance geometry. Assisted profiles are distinct, replay without rerunning segmentation, and restore their assistance setting on resume. A failed mask worker pauses assisted cache generation while retaining saved frames.

Existing maps are retained rather than silently rewritten. Select the assistance option to generate its profile. Recalibration adjusts existing maps; it does not rerun segmentation.

### Hybrid playback and durable caching

Hybrid mode analyzes ahead of playback, keeps a bounded hot queue in system RAM, and stores completed maps in browser IndexedDB. This absorbs short inference slowdowns without pretending RAM can replace GPU compute.

- Cached frames replay immediately and remain synchronized during normal playback and seeking, without requiring either AI backend to initialize first.
- Interrupted conversions resume after a reload when the same source is available.
- Compatible frames can be reused across detail and FPS profiles instead of starting every conversion from zero.
- Higher cache sampling rates can retain more source moments than the visible live-depth rate.
- Recalibration creates a non-destructive scene-aware stabilization overlay while preserving original maps.
- The cache library groups profiles by video and supports replay, resume, recalibration, reporting, per-video removal, and **Clear All**.
- **Delete profile** removes one profile's maps, calibration and feedback after confirmation, retaining the video and other profiles. Deleting the active profile switches to live playback so analysis cannot immediately recreate it. Shared-frame counts are refreshed from surviving profiles.

Browser storage is profile-specific. Clearing site data also clears the IndexedDB depth library.

### Explicit quality control

VoxelVision exposes three tuning policies:

- **Manual Lock** keeps the selected detail and depth FPS fixed.
- **Auto Detail Priority** preserves detail and adjusts FPS as measured performance changes.
- **Auto Motion Priority** favors the requested motion rate, reducing detail first when necessary.

Automatic governors downshift under sustained overload and recover upward after sustained headroom. Detail tiers use true max-edge semantics, so a 512 setting becomes `512 × 288` for 16:9, `512 × 384` for 4:3, and `288 × 512` for portrait 9:16.

### Conversion diagnostics

The depth diagnostic selector can show raw, normalized, stabilized, final, and cached-playback depth. The compact no-reference score samples the final depth actually presented during playback and compares it with the corresponding decoded video color, covering edge agreement, temporal stability, useful relief, border behavior, and precision. Before a conversion has been viewed, analyzed-map scores remain available as a fallback.

The score estimates conversion consistency and plausibility; it is not metric-depth ground truth. Cache cards also accept a user score, issue flags, scene notes, and timestamp. **Copy Report** produces a compact generation-focused report containing the source title/URL, conversion settings, cache state, score components, and user feedback.

## Quick Start

### Windows launcher

Double-click `VoxelVision.bat`, then choose the launch option.

### Command line

From the `Side-Builds` repository:

```powershell
cd VoxelVision
npm start
```

Open [http://127.0.0.1:9095](http://127.0.0.1:9095).

The repository has no npm package-install step. A recent Node.js runtime and a current Chromium-based browser are recommended. WebGPU provides the intended accelerated path; compatible WASM fallbacks remain available.

## Video Sources

### Bundled demo

The public-safe procedural demo and its authored depth cache are included. It is ready immediately and does not require an AI model download.

### Local video

Choose or drag a browser-supported video file. Frames are decoded and analyzed locally in the browser. When browser quota permits, the source and its depth profiles can be retained for cache replay and reload-safe continuation.

### YouTube

The local server can import public `youtube.com` and `youtu.be` URLs at 720p, 1080p, 1440p, 2160p, or source-max quality. Use option 4 in `VoxelVision.bat` to install or update the optional yt-dlp and FFmpeg helpers.

Downloaded media is placed under `public/media/imported/`, which is ignored by Git. Availability depends on the source, yt-dlp support, and local law or platform terms.

## Models and Runtime

Live depth is loaded lazily when an imported source needs inference:

```text
Enhanced: en970/depth-anything-v3-small-onnx
Balanced: onnx-community/depth-anything-v2-small-ONNX
```

Inference runs in isolated workers. Enhanced mode prefers DA3 FP16 Hybrid on WebGPU, routing its incompatible cubic resize node to CPU while keeping the transformer and depth head accelerated. Validated quantized WebGPU and WASM paths provide compatibility fallbacks.

Model weights are not committed to this repository. The browser fetches them from their upstream host on first use and may retain them in its browser cache. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance and license information.

## Performance Notes

- GPU/VRAM throughput is normally the live-inference limit; extra system RAM primarily helps the bounded analyze-ahead queue.
- Increasing voxel detail raises rendering and processing cost even when model input detail is unchanged.
- Increasing cached samples improves temporal coverage but does not make individual model inferences faster.
- Source resolution, browser WebGPU support, power mode, thermals, and scene complexity all affect sustainable throughput.
- Hybrid mode is recommended when smooth replay matters. **Live only** removes the intentional startup buffer but can expose inference latency.

## Privacy and Repository Hygiene

This public tree does not include private test videos, browser cache databases, machine-specific settings, generated screenshots, test-result artifacts, or downloaded yt-dlp/FFmpeg executables.

- Local-file frames are processed in the browser.
- YouTube importing sends the supplied URL only to the local VoxelVision server and its locally installed helper process.
- Depth caches and saved feedback remain in the browser profile unless the user copies or removes them.
- Imported YouTube media remains on the local machine in the ignored media directory.
- Generated reports intentionally contain the selected source title and URL so a report can identify the conversion under review.

Before publishing changes, run the public-release and verification checks described below.

## Verification

```powershell
npm run verify
```

Successful verification prints one summary line. Full passing detail is opt-in:

```powershell
npm run verify:verbose
```

The verification runner checks syntax and focused smoke suites for model profiles, depth stability, aspect handling, adaptive quality/FPS behavior, durable cache reuse and resume, fusion, foreground recovery, scoring, feedback reports, YouTube selection, and public-release hygiene.

Opt-in Chrome checks are `scripts/seek-runtime-smoke.cjs`, `scripts/cache-profile-delete-runtime-smoke.cjs`, and `scripts/assisted-depth-runtime-smoke.cjs` (requires Playwright and Chrome). Set `VOXELVISION_URL` for a test server and optionally `VOXELVISION_VIDEO_A` to a local media route. The assisted check downloads AI models; it is deliberately excluded from routine verification. Each check uses an isolated browser profile, prints one passing summary, and saves diagnostics under ignored `test-results/`.

## Project Layout

```text
VoxelVision/
|-- VoxelVision.bat                 Windows launcher and helper setup
|-- server.js                       Local HTTP/range server and hardware probe
|-- youtube-import.js               Local yt-dlp/FFmpeg ingestion bridge
|-- public/
|   |-- index.html                  Application shell and controls
|   |-- js/
|   |   |-- live-depth.js           Live inference and depth conditioning
|   |   |-- depth-model-worker.js   Isolated model runtime
|   |   |-- depth-ahead-controller.js
|   |   |-- depth-cache-*.js        Persistent cache, reuse, timeline, reports
|   |   |-- depth-render-fusion.js  Video-guided depth refinement
|   |   `-- voxel-scene.js          Instanced voxel renderer
|   |-- media/                       Public demo; imported media is ignored
|   `-- vendor/                      Local Three.js runtime
|-- scripts/                         Quiet verification and demo generation
|-- SMOKE-TESTING.md                 Test-output and diagnostics policy
`-- THIRD_PARTY_NOTICES.md           Runtime dependency provenance
```

## Additional Features

- Audio-reactive extrusion and rim lighting
- Cursor-focused wheel zoom and middle-drag dolly
- Camera presets and automatic orbit
- Video, charcoal, cyberpunk, and phosphor palettes
- 3D graph and procedural Retro TV modes
- PNG snapshots
- WebM canvas recording with audio when supported
- Native HTTP range serving for smooth local seeking

## License

VoxelVision source code is available under the [MIT License](LICENSE). Runtime models, media inputs, optional helper executables, and third-party libraries retain their respective licenses and terms.
