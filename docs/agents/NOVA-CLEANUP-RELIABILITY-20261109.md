# EveOS: Nova cleanup & reliability mission — 2026-11-09

**Status:** coordination handoff, not authorization to delete, uninstall, commit, push, or restart services. Read this alongside the existing canonical [`AGENTS.md`](AGENTS.md), not in place of it.

## 2026-11-10 resolution note

- Official Spotify Embed remains the supported non-Managed-Engine Spotify path. Its same-window queue transitions, completion fencing, status reconciliation, seek coalescing and fail-closed provider-outage behavior are now covered by focused regressions.
- The user-selectable **Electron Direct** playback mode and its dedicated bridge/runtime were retired. Legacy saved `electron` policies migrate to Official Embed. The generic authenticated Electron capture lane and Windows output helpers remain because Provider Capture still owns and tests them; they are not a third Spotify playback mode.
- Cleanup review artifacts are centralized under `C:\Users\alvin\Downloads\EveOS-Cleanup-Review-20261109`. Browser authentication/DRM profiles, active runtime state and the current Spotify freeze evidence remain protected unless a later exact manifest proves they are superseded.
- This note records the outcome of the campaign below; the original task inventory remains intact as historical rationale.

## Exact start state

- Project: `C:\Users\alvin\Documents\Workspace\RoughProjDeving\EveOS`
- GitHub: `driftai/EveOS`
- Active branch: `eve/nexus-machine-spaces`
- Last published/audio-qualified HEAD at handoff: `a25172b66dcee243c3ba8f496f1ebe979ead4b1e`
- Scope is an improvement/cleanup campaign **after** the accepted AudioFlix native audio/Managed Engine/Official Embed volume milestone. Preserve that milestone as a rollback.
- Confirm actual HEAD, branch, status, remote and live process state before doing any work. New commits made by Eve after this handoff take precedence only after exact-SHA review; never overwrite parallel work.
- **Evidence and visible deliverables:** `$HOME\Downloads\EveOS-Diagnostics\<purpose>-<YYYYMMDD-HHMMSS>\`.
- Repo source remains in the current repo, and runtime profiles/dependencies remain in their technically required locations. **Do not relocate OS-managed profiles, caches, browser installs, or working data into Diagnostics merely to satisfy the evidence location rule.**

## Strict owner split and execution order

| ID | Priority | Owner | Task | Gate / handoff |
|---|---|---|---|---|
| E-1 | P1 | **Eve source + mock tests** | Repair broken **Open all URLs in a card** action; first trace the actual handler and browser permission/popup behavior | Same card, exact URLs, clicked once; invalid URLs not opened; no silent duplicate tabs; pointer-level Playwright test |
| E-2 | P1 | **Eve source + deterministic tests** | **Official Spotify Embed**: after a song's verified Ended event, load/auto-play the next queue item in **the same** owned Edge Beta window; do not break managed-engine mode | Exactly one queue advance per revision; no duplicate player windows; no premature end on paused/seek; next media load/play verified |
| E-3 | P1 | **Eve source + targeted timing probes** | Piano internal play starts late, sounds choppy as complexity increases, eventually times out; compare `http://127.0.0.1:8765` to `file://` only as diagnostic evidence | Separate front-end handshake, source data prefetch, event scheduler and PCM/native route latency; test dense chords/holds, no dropped notes, no blocking UI |
| E/N-4 | P1 | **Eve deterministic soak; Nova actual headed soak** | Play Group stops/freeze after ~30+ Spotify songs (mode unspecified); capture **which mode, what revision, and where the first stalled handoff occurs** | Simulated 40+ transitions with bounded memory, then licensed real-player long-session test without assuming bug is specific to Official Embed |
| N-1 | P1 | **Nova local lifecycle** | Stop Piano and stop WatchFusion/terminal-controlled tools sometimes never reach or stop their owned process | Enumerate actual PID/process tree/port ownership, confirm route and API before stopping; no blind `taskkill`, no kill-by-port; idempotent stop/restart tests |
| N-2 | P1 | **Nova device/network sync** | WatchFusion “Link playing tab” with YouTube shows drift/lag across tab -> WatchFusion -> remote device | Time-stamp capture/emit/receive/render/seek correction, isolate network jitter vs delayed state publication; LAN/phone headed two-device validation |
| N-3 | P1/P2 | **Nova local inventory; Eve supports design** | Triage legacy `$HOME\Downloads` ZIPs and extracted folders, old `AppData` and `%TEMP%` EveOS evidence, strays near `$HOME`, browser runtimes, and `EveOS-Diagnostics` | Read-only inventory, dependency/uniqueness/retention classifications before quarantine; user approval before permanent deletion |
| N-4 | P2 | **Nova architecture inventory; Eve advises** | Assess legacy Spotify Electron Direct/Deferred integration, and any reusable app window/routing/host components for World Book or other services | Map consumers and tests first; remove UI deferred choice only after compatibility tests; retain useful modules only with an actual qualified owner/use case |
| N-5 | P1 | **Nova** | Recheck all Eve repairs on the real Windows build and file/localhost parity | Focused regressions first, server restart only under verified owner, headed proof + one receipt per verified fix |

**Parallel ownership:** Nova may start N-1/N-2 and read-only N-3 independently while Eve tackles E-1/E-2/E-3. Nova must not edit E-1/E-2/E-3 files in parallel with Eve. Cross-owner findings return as precise evidence, not an overlapping rewrite. Source fixes and cleanup are independent milestones: do not delete inputs needed by a failing test.

## Source leads already identified by Eve (inspect, do not assume root cause)

- Card rendering: `js/modules/ui/dashboard/categories/builder-card.render.full.links.js`; the *click handler* still needs precise discovery. Inspect card context menu / actions and bookmarks link opener, and distinguish popup blockers from bad event wiring. Avoid unbounded mass opening.
- Official Embed browser adapter: `js/modules/features/audioflix/audioflix.spotify.edge.js` (queue connection, status polling and Ended notifications); backend: `server_modules/audioflix_spotify_edge_session.py` (`endedRevision`/`mediaRevision`, revision fencing), `server/spotify-embed-edge.html` (SDK playback events and `media-loaded` acknowledgements), `server_modules/audioflix_spotify_edge_lifecycle.py`. A track completing does **not** itself prove the next track actually loaded: test both transitions separately.
- Piano: `js/modules/features/audioflix/audioflix.piano.frontend.js`, `audioflix.piano.frontend.ports.js`, `audioflix.piano.pcm.js`, `audioflix.piano.client.js`; `tools/Piano-Auto-Player/app/playback.py`, `playback_timing.py`, `midi_performance.py`. Distinguish a note scheduler under load from the network/PCM transport and UI control handshake.
- Stop Piano UI/API: `js/modules/features/audioflix/audioflix.piano.client.js` `setRunning(false)`; investigate controller `/api/piano-player/stop` and Windows process ownership. WatchFusion lifecycle is separately managed; never infer same root cause without evidence.
- WatchFusion: `tools/WatchFusion/public/client/linked-tab.js`, `linked-playback-sync.js` and `tools/WatchFusion/public/playback-sync.js`. Current code has drift/anchor and queued mirror behavior; capture actual timing before tuning thresholds.
- Spotify Direct/Electron: `js/modules/features/audioflix/audioflix.spotify.direct.js`, `server_modules/audioflix_spotify_direct.py`, `server_modules/audioflix_spotify_engine_direct_route.js`, experimental Electron host. Identify references in `package.json`, UI, tests, launchers, World Book, and running processes before deleting any module.
- Relevant canonical existing rules: `docs/agents/AGENTS.md`, especially service identity, 440/450-line limits, verified restarts, guarded commits, no new branches without closure, no forced publication, and quota discipline.

## Cleanup: investigate -> classify -> preserve/reuse -> quarantine -> user-approved delete -> verify

1. **Read-only inventory FIRST.** Enumerate names, locations, type, timestamps, byte sizes where cheap, and shallow dependency references. Do not recursively ingest user content, hidden browser secrets, cookies, tokens, licensed media, auth profiles, or complete home-directory files. Use the bundled bounded inventory script if useful.
2. **Categorize every candidate:** ACTIVE RUNTIME / REQUIRED DEPENDENCY / CURRENT RECEIPT / UNIQUE RECOVERY BACKUP / POTENTIALLY REUSABLE MODULE / SUPERSEDED BUT USEFUL EVIDENCE / DUPLICATE BY SHA / PROPOSED QUARANTINE / UNKNOWN. Missing dependency evidence means UNKNOWN, not delete.
3. **Inspect retention:** verify a file is already represented by an accepted commit, or preserve the last exact validated recovery snapshot; compare SHA256 only where it adds real value. Preserve Windows installer packages if needed for offline recovery until reviewed.
4. **Browser/runtime inventory:** distinguish Edge Beta managed-Engine profile vs separate Official Embed Edge Beta profile; Playwright-managed Chromium vs independently installed Chrome vs system Chrome; Camoufox and Lightpanda; Electron app shells; profile/DRM/auth-bound state. Existing Chromium is not automatically junk. Browser binaries and OS-managed caches are **not** diagnostics, and may legitimately live in AppData. Do not delete a live profile or uninstall an executable just because it resembles a duplicate.
5. **Reuse only with an owner and a test:** each salvaged capability must have a concrete consumer/module, performance or functionality benefit, dependency and security review, focused regression and real acceptance. A speculative idea is a backlog item, not grounds to retain an entire obsolete experiment forever.
6. **Quarantine uncertain obsolete artifacts** into **one clearly visible, conflict-safe review folder under** `$HOME\Downloads\EveOS-Diagnostics\Cleanup-Review-<timestamp>`, with a before/after manifest, hashes for moved files and source paths; do not silently zip, copy or move everything. Keep protected active artifacts in place. Do not flatten filenames or overwrite collisions.
7. **NO permanent deletion until user approves the exact manifest.** In particular, no broad AppData/Temp cleaning, no `%LOCALAPPDATA%\ms-playwright` purge, no Edge Beta profile removal, no `%USERPROFILE%` root deletion by wildcard, no Git branch deletion without ancestry/PR/worktree/live-consumer review.
8. **Post-change verify:** run all affected tests/live probes; audit paths for no new diagnostic writes into `$env:LOCALAPPDATA\EveOS-Tests`, `%TEMP%` or hidden stores except genuinely ephemeral scratch; verify active services, git state and recoverability.

### Local inventory targets (not a delete list)

- `$HOME\Downloads\EveOS-*`, `AudioFlix-*`, `Spotify-*`, backup/probe ZIPs and extracted twins; include any generic `SHA256-MANIFEST.json` only after proving its owner.
- `$HOME\Downloads\EveOS-Diagnostics` existing runs: retain recent accepted proof, singular recovery snapshots, and pending-failure evidence; don't bulk clear the canonical destination.
- `$env:LOCALAPPDATA\EveOS-Tests`, `$env:LOCALAPPDATA\EveOS`, `$env:LOCALAPPDATA\Temp`, `$env:TEMP`, `$env:APPDATA`, `$HOME` root (bounded searches only), relevant browser install/cache registries.
- Known legacy examples include `EveOS-Complete-Publish-Resume-v1.*`/`v2.*`, `EveOS-Spotify-Edge-Repair-v3.*`–`v5.*`, `EveOS-Playwright-Chromium-Audio-Isolation-*`, `Spotify-Widevine-Playwright-Probe-v1`, `EveOS-Electron-Embed-*`, `EveOS-Venv-Audio-Guard-*`, `EveOS-AudioFlix-Publication-Guard-*`. These are **candidates**, not preapproved deletions; some might be a unique rollback or record.
- Other files stored outside `Downloads` may be active source, memories, or user work; treat anything not clearly owned by the project as out of scope until Drift explicitly approves.

## Diagnostic convention to propagate to Nova's canonical instructions

**All persistent shareable EveOS diagnostic evidence** (test receipts, probe reports, logs, screenshots, trace summaries, manifests, handoffs) goes under:

`C:\Users\alvin\Downloads\EveOS-Diagnostics\<purpose>-<YYYYMMDD-HHMMSS>\`

Never default new shareable evidence to `%LOCALAPPDATA%\EveOS-Tests` or `%TEMP%`. **Exception:** genuine process-private runtime state, Playwright/Chrome/Camoufox profile data, lockfiles, caches, OS-managed installation data and short-lived scratch must remain where their tooling requires; do not copy secrets or live session data to Diagnostics.

Nova's initial local task is to locate her own existing canonical agent state/instructions and *add a short pointer* to this repository memo and the destination convention. Do not guess or create hidden agent-state files or scatter duplicate prompts. `AGENTS.md` is repo-discoverable through the root pointer; use the canonical repo instructions and keep them consistent with the durable Library workflows.

## Tests, handoffs, and stop conditions

- Unit/deterministic/browser smokes first; register new entry points in the smoke registry and maintain zero backlog. Check `npm run --silent test:guardrails` after each coherent change; final `npm run verify` only when a coherent change set is ready. Maintain <440 line growth and 450 hard cap; never hide files from guards.
- For E-1: Playwright actual click and **valid/invalid URL** tests, 1/3/N links, popup policies, focus mode and file/localhost behavior.
- For E-2 and E/N-4: fake SDK/event test checks missing/duplicate/out-of-order `ended`, `media-loaded`, `play-failed`, same-URI repeated queue entries, auto-start refusal, audio-route loss, listener cleanup, 40+ handoffs; headed acceptance via real Spotify/Edge Beta, isolated to a user-authorized session.
- For E-3: latency histogram and dropped events / onset-to-sound gap for 1/4/16/32 concurrent notes, 3–5 min dense playback, memory/CPU and endpoint identity. Avoid arbitrary sleeps or restarting unrelated apps as a 'fix'.
- For N-1: start/stop/restart twice; verified exact owned PID tree ends, port state and manager status settle; a foreign owner on same port is never terminated.
- For N-2: collect sample timestamps/clock offsets on source, EveOS relay and remote client; verify target drift under steady play, seek, pause, URL switch and slow network. No unsupported exact-latency promise in advance.
- For N-3: publish **inventory.csv**, **retention-decision.md** (`path`, role, size, evidence, decision, owner, rollback), **quarantine-manifest.json**, and **approval-required.md**, not a pile of untracked ZIPs.
- For all: preserve user secrets, never emit tokens or browser cookies. Write the summary path under Downloads Diagnostics and report the exact source SHA, files changed, tests, live outcomes, branch status and why any candidate is still retained. Don't spend hosted quota redoing Eve's static work; return concrete evidence to Eve when an architectural bug surfaces.

**No cleanup is complete until the approved manifest's deletions and post-cleanup checks are verified.** The current publication (`a25172b66`) is completed and should not be reworked without a concrete regression.
