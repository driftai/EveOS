# EveOS

**A local-first personal workspace for bookmarks, media, research, worldbuilding, AI-agent collaboration, automation, and user-owned knowledge.**

> **Current public milestone: EveOS 0.7.0 — Nexus Browser update (September 24, 2026)**
>
> EveOS is built around one idea: the structure you spend time creating should stay under your control. Core workspace data can live locally, be exported, be inspected, and be moved without requiring a hosted EveOS account.

EveOS started as a way to organize links and grew into a connected desktop-style workspace: nested dashboards, library metadata, search, maps, media playback, generative audio, AI-assisted tools, a private World Book, a world-map editor, a full Piano Auto Player, and the WatchFusion media/watch-party workspace now live in one system.

It is Windows-oriented, browser-first, and intentionally modular. Many core workflows still work directly from `EveOS.html`; localhost and companion services unlock filesystem access, native audio, AI backends, World Book, Piano Automation, WatchFusion, and other machine-level features.

> **Project scale:** Run `npm run smoke:file-size` for the current first-party file count, physical line totals, per-language breakdown, and 450-line architecture check. The [Project Size](#project-size) section explains the scanner and historical snapshot.

![EveOS dashboard with a synthetic demo datapack](docs/screenshots/eveos-dashboard.png)

*The public screenshots use synthetic demo content. Personal datapacks, private World Book data, saved Piano libraries, credentials, and machine-local state are not included in the repository.*

## Start here

- [What's new in 0.7.0: Nexus Browser and Agent-Only Mode](#nexus-browser-update--eveos-070)
- [Workspace overview](#the-workspace-at-a-glance) and [Unidex / Smart Views / Nebula](#unidex-smart-views-and-nebula)
- [Getting started](#getting-started) and [Nexus Browser setup](#nexus-browser-quick-start)
- [Data ownership and privacy](#your-data-and-privacy)
- [Architecture](#architecture) and [repository map](#repository-map)
- [Measured project size](#project-size), [verification](#verification-and-development-safety), and [qualification status](#current-project-status)

## Nexus Browser update — EveOS 0.7.0

![You wouldn't want a human in control — EveOS Nexus Browser announcement](docs/screenshots/eveos-nexus-browser-promo.png)

*The announcement image is a tongue-in-cheek remix of the classic anti-piracy meme, not a change to EveOS ownership or access policy: the workspace owner remains in charge of their agents, permissions, and services.*

**Nexus Browser is now integrated into the EveOS Agent Nexus workspace.** It brings the Browser AI Bridge/Dex transport into a separately supervised, on-demand local service rather than making every EveOS feature depend on an always-on bridge.

| What changed | Where to find it |
| --- | --- |
| **Browser-targeted agents** | The EveOS-owned Chromium extension under `tools/Nexus-Browser/extension/` provides scoped provider adapters for supported, already-authenticated tabs. |
| **Dex coordination** | Rooms, participant selection, target routing, durable local transcripts, exact-once dispatch records, post-timeout capture-only recovery, and bounded incident diagnostics live in the Nexus Browser runtime. |
| **Agent-Only Mode** | Dex starts each browser load as an observer-first workspace: human room editing and relay-management controls are disabled until **Enable Human Input** is selected. Room browsing and message composition remain available in either mode, subject to existing runtime safeguards. |
| **Agent Nexus and TLO** | Search Monitor presents Nexus Browser next to the TLO chat surface and Agent Management, without sharing their private data by default. |
| **Explicit lifecycle** | Local Control owns setup/start/stop, supervised processes, port registration, and safe shutdown. Opening Agent Nexus is a status read, not an instruction to start services. |
| **Private by default** | Room state, message history, browser sessions, agent profiles, incident logs, and credentials remain in ignored local runtime storage. Public Git includes source, schemas, examples, documentation, and deterministic tests only. |

Nexus Browser's default local address is `http://127.0.0.1:9088/`, governed by `NEXUS_BROWSER_PORT` in `config/eveos-ports.json`. Its canonical extension and runtime live in the EveOS tree; you do not need to execute the old Browser AI Bridge POC from another checkout. Existing extension installations must be repointed to the EveOS folder once.

**Scope of this milestone:** the integrated source and deterministic contract coverage are present. Authenticated provider round trips, browser-extension reconnection, local process ownership, headed-browser behavior, and your installed models still require qualification on the actual machine. Do not mistake a passed source smoke or a connected tab for permission to control an agent.

**Agent-Only Mode is a UI editing gate, not a new agent permission grant.** The human owner can browse rooms and send messages while editing is locked; sending still requires the connected primary Dex viewer and an eligible, idle room. The slowly pulsing red **Enable Human Input** button unlocks room identity, participant, and relay controls on the primary viewer. The unlock is not persisted: reloading returns to Agent-Only Mode. Authorized agents retain their separate, exact-room-scoped command path, including its busy-state and target-identity checks. Switching between Base Mode and Dex Mode does not stop localhost-owned agent relays. See [Nexus Browser's operating guide](tools/Nexus-Browser/README.md#agent-only-mode-and-human-input).

For architecture, migration, safety boundaries, and the local-live qualification checklist, see [Nexus Browser integration](docs/NEXUS-BROWSER-INTEGRATION.md) and [Agent Nexus migration](docs/AGENT-NEXUS-MIGRATION.md).

## Why EveOS Exists

A useful digital collection can take years to build and seconds to become less useful when a service removes a video, changes a playlist, deletes a title, closes an API, retires a feature, or locks the organization behind one account.

EveOS takes the opposite approach:

- **Own the structure.** Bookmarks, folders, cards, notes, metadata, relationships, and supported media records can be stored in formats you control.
- **Keep local copies when they matter.** Online providers are useful sources, not the only place the organization is allowed to exist.
- **Export and restore.** Datapacks, scoped backups, World Book recovery, Audioflix transfer, and Piano library transfer make state portable.
- **Use online services optionally.** Gemini, Spotify, YouTube, metadata providers, narration, search providers, and transcription engines enhance EveOS without becoming its sole source of truth.
- **Let tools connect without becoming one monolith.** Audioflix, WatchFusion, World Book, World Portal, Piano Automation, Matrix, Nexus, Gemini Link, and the dashboard keep their own boundaries and communicate through explicit integration layers.

Local-first is not the same thing as indestructible. Remote media can still disappear and a local disk can still fail. EveOS is designed to make preservation and migration possible; important data should still be backed up independently.

## The Workspace At A Glance

| Area | What it does |
| --- | --- |
| **Dashboard** | Nested workspace tabs, cards, folders, bookmarks, notes, shortcuts, pinning, ordering, task states, focus views, and bulk operations. |
| **Unidex** | A unified dashboard view for navigating workspace/card content and bookmark entries, including alternative layouts, scoped task indicators, and restoration of the selected view after reload. |
| **Smart Views** | Saved, criteria-based and built-in views over existing bookmark/folder data, including query-based discovery without moving the underlying records. |
| **Nebula** | Stable `eve://` workspace/card/folder/bookmark links plus validation and transactional JSON-patch plumbing for linked workspace data. |
| **Library** | Rich media records, aliases, status tracking, chapters/episodes, covers, source attachments, provider metadata, and blended ratings. |
| **Nexus Search** | Searches the current scope or the wider datapack while preserving paths, provenance, location, and jump-back context. |
| **Constellation Map** | Turns the workspace into a navigable graph while retaining the relationship to the active tab/card context. |
| **Matrix Workshop** | A visual workspace for alternate navigation, datapack-aware widgets, phone-style controls, cover atlases, and experimental interfaces. |
| **Audioflix** | Local-first soundboard and music library, playlists, routing, Spotify playback, Instagram/Reel support, local media paths, queues, grouping, filtering, backup/restore, and tool hosting. |
| **WatchFusion** | On-demand local media/watch-party workspace for YouTube, direct/HLS media, Nuvio, VoxelVision, rooms, chat, synchronized playback, LAN use, and optional remote tunnels. |
| **Piano Automation** | Integrated Piano Auto Player with sheet search, MIDI/timed performances, recording, internal preview, 61/88-key layouts, window-target playback, media-to-piano transcription, bulk conversion, staging, and library transfer. |
| **Sonic Forge / Sound Lab** | Live generative music controls, prompt steering, scenes, recording, MIDI, visualization, native capture, and routed playback. |
| **World Book** | A private local lore workspace for real files, virtual lore, tags, statuses, links, canon/integrity tooling, imports, recovery, and Eve-controlled injections. |
| **World Portal** | A connected multi-world map environment housed inside World Book, with per-world geography, view state, custom worlds, portable world packages, and runtime switching. |
| **Reader Library** | Private document import, passage navigation, browser/Gemini narration, generated-audio cache handling, source-aware recovery, and read-aloud workflows. |
| **Gemini Link** | Optional live AI conversation, scoped EveOS context relay, screen/audio-oriented integrations, usage/session controls, and backend-managed credentials. |
| **Agent Nexus / TLO** | Private scoped agent profiles and an optional local-model chat surface that uses an already-running Local MoE Harness; opening TLO does not auto-start inference. |
| **Nexus Browser / Dex** | Explicitly started browser-agent transport with room coordination, supported-provider extension adapters, incident evidence, and durable local recovery. |
| **Search Monitor / Control Plane** | Runtime visibility and lifecycle controls for EveOS localhost and optional companion services without forcing every service to run together. |

### Unidex, Smart Views and Nebula

These are different parts of the same data-navigation layer rather than interchangeable search engines. **Unidex** presents unified cards or entries across the selected workspace scope and preserves entry layout/navigation state. **Smart Views** save filter criteria and expose built-in collections (including system views) that can also be discovered through Nexus Search. **Nebula** supplies ID-oriented `eve://` links that continue to resolve folder paths after renames, together with validated workspace JSON-link and patch operations. Workspace scope and stable IDs matter throughout: changing how data is viewed should not silently move or duplicate its source records.

## Explore The Interface

### Search without losing where something came from

![Nexus Search using synthetic local-first results](docs/screenshots/eveos-nexus-search.png)

Nexus Search keeps structural context attached to results. A search result is not just a title: EveOS can retain the workspace, card, folder, visibility, source, and other provenance needed to get back to the place where the item actually lives.

### Keep media, playback, and generative audio together

![Audioflix Sonic Forge](docs/screenshots/eveos-sonic-forge.png)

Audioflix is the shared media surface for saved sounds, music, provider-backed playback, local media, queues, routing, and integrated tools. Sonic Forge builds on that audio layer for live generative music without turning generated output into the ownership layer for the rest of EveOS.

### Build a private world and listen to it

![World Book Reader Library with a synthetic local-first document](docs/screenshots/eveos-reader-library.png)

World Book is a self-contained local service controlled by EveOS. Reader Library adds private imported documents, continuous progress, passage navigation, narration, and recovery-aware source tracking. World Portal is housed inside the same tool family so geography remains connected to the world/lore domain rather than being owned by an unrelated UI module.

## Audioflix

Audioflix is EveOS's canonical audio/media workspace. Tracks and soundboard clips are stored once and other EveOS surfaces can hold lightweight references to those records rather than duplicating the entire media item everywhere.

Current Audioflix capabilities include:

- music and soundboard libraries;
- folders, groups, playlists, classifiers, smart/artist filtering, and tri-state include/exclude filters;
- Spotify-backed playback and playlist-oriented workflows;
- Instagram/Reel playback and retained playlist metadata;
- local media paths and native-output routing;
- queue and layer controls;
- sound generation and Sound Lab/Sonic Forge integration;
- scoped Audioflix links from workspace, card, folder, and bookmark surfaces;
- full and scoped backup/restore behavior;
- dedicated Piano Automation hosting and Piano library transfer.

An online URL is not treated as proof that media has been archived. If a track matters long-term, localize the media and keep your own backup.

## WatchFusion

WatchFusion is now housed canonically inside EveOS under `tools/WatchFusion/`; the former Private-Test-Builds staging copy has been retired. Opening its EveOS panel is presentation-only: the Node runtime remains on-demand and is started explicitly when needed.

The integrated workspace combines:

- solo YouTube, direct-file, and HLS playback;
- synchronized watch-party rooms, host transfer, chat, playback state, and room links;
- Nuvio catalog/addon integration through a user-installed external Nuvio tree;
- bundled VoxelVision 3D/depth playback;
- LAN sharing and optional Cloudflare Quick Tunnel remote sharing;
- EveOS lifecycle/setup controls and the canonical WatchFusion port registry entry.

The watch-party lineage comes from [`howardchung/watchparty`](https://github.com/howardchung/watchparty). WatchFusion's current Nuvio setup uses [`NuvioMedia/NuvioTVSmart`](https://github.com/NuvioMedia/NuvioTVSmart); older references may point at the historical `NuvioMedia/NuvioWeb` URL. Upstream licensing/attribution is documented in [`tools/WatchFusion/THIRD_PARTY_NOTICES.md`](tools/WatchFusion/THIRD_PARTY_NOTICES.md).

WatchFusion's privacy model is intentionally narrower than “anything on the host is remotely visible”: host network/setup diagnostics are host-local, remote VoxelVision status redacts machine hardware details, file serving is constrained to explicit public roots with real-path containment checks, and external media/addon proxy destinations reject private/loopback targets. Remote proxying still uses the WatchFusion host as the network egress point, so public upstream media services can see the host network's public IP. See [`tools/WatchFusion/SECURITY.md`](tools/WatchFusion/SECURITY.md) for the full boundary and limitations.

## Piano Automation

The complete Piano Auto Player is now housed inside EveOS under `tools/Piano-Auto-Player/` and surfaced from **Audioflix > Piano**.

![Piano Automation interface overview](docs/screenshots/eveos-piano-automation-overview.svg)

*Interface overview of the integrated Piano workspace: Sheet Player, target-window playback controls, temporary Player Cache, From Sheet Finder staging, and bulk media conversion.*

The bundled tool keeps its own Python service and frontend while EveOS manages its lifecycle. Its core capabilities include:

- multi-provider sheet search;
- manual Virtual Piano-style sheet input;
- standard MIDI and timed-performance import;
- exact-timing recording from the built-in practice piano;
- Play / Pause / Stop / Resume and event-level seeking;
- 61-key C2-C7 and 88-key A0-C8 target layouts;
- foreground playback and experimental Virtual Target window-scoped delivery;
- Internal Play for auditioning without sending keys to another application;
- sampled internal piano presets with an offline synth fallback;
- local Song + Recording Library import/export;
- whole-library ZIP transfer and individual `.piano-song.json` transfer;
- Media / Spotify -> Piano transcription;
- Basic Pitch and optional Transkun-based Auto Hi-Fi model-family consensus;
- retained YouTube session support stored outside browser localStorage;
- source-space timing, sustain, reattack, range-adaptation, and target-key lifecycle handling.

### Bulk conversion and sheet staging

The newer workspace flow separates **finding/converting** a sheet from **replacing the active player**.

- Sheet Finder results are staged in **From Sheet Finder** instead of immediately overwriting the active sheet.
- Completed AI conversions go to that same staging inbox.
- Loading a staged item is an explicit final choice and removes it from staging.
- The active Sheet Player keeps a temporary **10-item Player Cache** for back/forward navigation without silently saving those sheets to the permanent library.
- Bulk Conversion accepts many media URLs at once and processes the heavy transcription work sequentially so model/GPU jobs do not fight each other.
- Bulk URLs can be separated by whitespace, commas, lines, or simply by the next `http://` / `https://` boundary.
- A plain `.txt` file containing URLs can be queued directly.

Private Piano songs remain in `tools/Piano-Auto-Player/data/songs.json` and are intentionally excluded from Git.

## World Book, Reader Library, And World Portal

World Book is a real local application rather than a cosmetic EveOS panel. EveOS can start, stop, embed, and detach it while the tool continues to own its own world/lore domain.

![World Book workspace interface overview](docs/screenshots/eveos-world-book-workspace-overview.svg)

*Interface overview of World Book's mounted workspace, responsive header controls, live-file tree, and connected lore editor.*

The bundled World Book currently reports **0.16.0** and includes:

- mounting a real Windows workspace path such as `C:\Lex-Temp`;
- browsing live files alongside virtual World Book entries;
- tags, statuses, semantic kinds, notes, links, backlinks, smart collections, and integrity views;
- controlled Eve Injection JSON workflows;
- import, backup, restore, deleted-item recovery, and move history;
- Reader Library private document storage;
- browser speech and optional Gemini narration;
- source-aware generated-audio cache handling;
- narration recovery coverage;
- responsive and collapsible header controls for embedded/narrow layouts.

### World Portal

World Portal lives at `tools/World-Book/tools/World-Portal/` and follows an ownership-first geography model: a world is the root object that owns its surface, continents, countries/territories, focused geography records, boundaries, measurements, rivers, lakes, future subdivision layers, and view settings.

Custom worlds are independent root records. They can be switched at runtime and exported/imported as portable `.world-portal.json` packages. The UI is expected to route geography through the World Portal domain gateway instead of letting unrelated modules independently own map state.

## Local-First Modes

EveOS can operate at several levels. You do not have to start the entire stack to use the workspace.

| Mode / service | Typical role |
| --- | --- |
| **`file://` — open `EveOS.html` directly** | Core browser workspace, local browser state, many dashboard/library/search flows. Optional service connection errors simply mean those services are off. |
| **EveOS localhost — `127.0.0.1:8765`** | Backend-assisted workspace, modular disk store, filesystem-oriented features, proxy/resolver paths, native bridges, and wider integration support. |
| **World Book — `127.0.0.1:8766`** | Private World Book / Reader Library service. Managed independently through EveOS control. |
| **Piano Auto Player — `127.0.0.1:8771`** | Piano sheet playback, recording, library, target-window automation, and media conversion service. |
| **Local control plane — port `9082`** | Lifecycle manager used by file-mode EveOS to start/stop optional local services. |
| **WatchFusion — `127.0.0.1:9087` by default** | On-demand local media/watch-party runtime. LAN and tunnel exposure are explicit separate launch modes. |
| **Nexus Browser — `127.0.0.1:9088` by default** | Supervised local browser-agent bridge with an optional unpacked extension. Start it explicitly in Agent Nexus. |

Gemini and other optional backends keep separate lifecycle state as well. Starting EveOS localhost does not imply every AI, World Book, Piano, or WatchFusion service must also be running.

## Getting Started

### Recommended Windows path

Requirements for normal use depend on which features you enable, but the main repository is built around:

- Windows 10/11;
- a current Chromium-based browser;
- Python **3.10 or 3.11** for the Python runtime and companion services;
- Node.js **20+** for development, audits, builds, and smoke tests.

For the normal launcher flow:

1. Clone or download the repository.
2. Install the Python requirements if you plan to use localhost/backend features.
3. Run `start-server.bat`.
4. Choose **Start EveOS port only** for a plain localhost instance, or **Start EveOS instance** to launch against a selected datapack/modular-store path.
5. Open the address shown by the launcher, normally `http://127.0.0.1:8765/EveOS.html`.

### Browser-only path

Open `EveOS.html` directly.

In `file://` mode, browser-side features stay available without the Python server. On Windows, `tools\batch\install-eveos-control-protocol.bat` can register the per-user `eveos-control://` launcher so the file-mode page can cold-start the local control plane after the browser's external-app confirmation.

Features that require filesystem access, native routing, modular disk storage, AI backends, World Book, Piano Automation, WatchFusion, or other companion services still require the relevant local runtime.

### Nexus Browser quick start

From a checked-out EveOS repository on Windows, install the root dependencies, start the normal EveOS launcher, then open **Search Monitor → Agent Nexus → Nexus Browser**. Read its passive status before choosing the explicit start action. The bridge is separate from the main EveOS localhost service.

```powershell
npm ci
.\start-server.bat
# After the EveOS-owned Nexus Browser service starts, check its local dashboard:
Start-Process 'http://127.0.0.1:9088/'
```

In Chromium, visit `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `tools/Nexus-Browser/extension` from *this* checkout. Repoint any older Browser AI Bridge extension instead of running two competing copies. Provider access uses your existing authorized tabs; no automatic provider login or universal browser permission is implied.

#### Nexus Browser operator commands

With the EveOS-owned Nexus Browser service already running, use the commands from its own directory (these are **not root-package scripts**):

```powershell
Set-Location tools/Nexus-Browser
npm run doctor
npm run extension:reload      # Reload the unpacked extension and verify reconnect
# Alternative for extension-code changes: validate first, then reload
npm run extension:refresh
Set-Location ../..
```

Run **one** of the two reload options, not both: `extension:refresh` includes `extension:reload` after `validate:shared`. Reloading the extension does not restart the localhost Nexus service; when server/supervisor code changed, restart the service through EveOS Local Control first. Qualified, exactly bound Online-Origin Dex agents can also issue `[[DEX:CMD {"action":"reload_extension","room":"<exact room id>"}]]`. Localhost authorizes the exact room/chat and requires every Dex room to be idle, then checks the extension reload acknowledgement, new connection epoch, fresh target snapshot, and recovered provider-control channel before returning success. This grants no shell execution. Keep the npm commands as the operator fallback, including for the initial update that installs this feature. See the [Nexus engineering workflow](tools/Nexus-Browser/ENGINEERING-EFFICIENCY.md) for the full qualification and diagnosis procedures.

If you have private rooms in an older POC checkout, use the migration dry run first. Stop the Nexus Browser service before applying an import. Replace the placeholder with the **absolute path** to the legacy folder:

```powershell
node tools/Nexus-Browser/scripts/import-legacy-rooms.js --source 'C:\path\to\legacy-folder'
# Review the dry-run report, stop Nexus Browser, then run explicitly with --apply.
```

Do not copy private browser profiles, `.browser-ai-bridge`, saved credentials, or unrelated local logs into Git. See [Nexus Browser integration](docs/NEXUS-BROWSER-INTEGRATION.md) for ownership and recovery details.

### Fresh development checkout

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
npm ci
start-server.bat
```

Python runtime dependencies currently include Gemini Live support, WebSockets, Vosk, pydub, NumPy/sounddevice, `yt-dlp`, and PyMuPDF for Reader Library PDF extraction. Piano's optional transcription stacks use their own isolated environments so TensorFlow/Basic Pitch and PyTorch/Transkun dependencies do not have to contaminate the root EveOS environment.

## Datapacks And Modular Storage

EveOS supports both a unified in-memory app state and a modular flat-file store.

When localhost mode is active, the modular store can mirror the workspace hierarchy on disk:

```text
data/modular-state/
└── tabs/
    └── <workspace>/
        ├── tab.json
        └── cards/
            └── <card>/
                ├── card.json
                ├── entries/
                │   └── <bookmark-id>--<title>.json
                └── _library-unlinked.json
```

The store root is configurable, so separate EveOS instances can use separate datapack folders and ports. Different localhost ports also provide separate browser origins/localStorage contexts.

Backup scopes can operate at multiple levels, including full datapack, workspace/tab, card, folder/bookmark-oriented flows, and tool-specific recovery where appropriate.

## Your Data And Privacy

EveOS deliberately separates portable user state from machine-local or secret state.

### Intended portable/user-owned state

- workspace tabs, cards, folders, bookmarks, notes, and settings;
- library records and supported source metadata;
- Audioflix records and scoped links;
- supported datapack exports and modular JSON stores;
- World Book recovery packages when explicitly created;
- Piano song/library exports when explicitly created.

### Intentionally local or excluded from Git

- API credentials and secrets;
- browser-granted filesystem permissions;
- generated caches and temporary runtime files;
- private World Book runtime data;
- private Reader Library source documents;
- `tools/Piano-Auto-Player/data/songs.json`;
- retained YouTube/Piano authentication session material;
- isolated Piano transcription environments;
- local audio/device-routing state;
- user-installed WatchFusion Nuvio source/build data and local wrapper properties;
- Nexus Browser Dex rooms, local transcripts, turn ledgers, browser sessions, incident reports, and legacy `.browser-ai-bridge/` state;
- private Agent Management profiles and TLO conversation state;
- downloaded WatchFusion/VoxelVision helper binaries and imported VoxelVision media.

Optional integrations send the data required by the feature you explicitly use and are also subject to the external provider's own terms and privacy behavior. WatchFusion remote media proxying additionally means public upstream media/addon services can observe the WatchFusion host network as the request source; it does not intentionally grant room participants arbitrary filesystem or LAN access.

Before large restores, migrations, imports, or experimental changes, keep an independent copy of anything you cannot recreate.

## Architecture

At a high level:

```text
                          ┌─────────────────────┐
                          │      EveOS.html     │
                          │ browser entry point │
                          └──────────┬──────────┘
                                     │
                 ┌───────────────────┼───────────────────┐
                 │                   │                   │
         js/modules/*         css/modules/*       manifest/config
        state + features      scoped styling       load ordering
                 │
                 ▼
        optional local control / Python runtime
                 │
      ┌──────────┼───────────────┬────────────────┐
      │          │               │                │
   EveOS      World Book     Piano Auto       Gemini/audio/
 localhost    + Portal        Player          native helpers
                 │
                 └──────────── WatchFusion (on demand)
```

Agent Nexus introduces another deliberately separate runtime: `tools/Nexus-Browser/` runs the supervised local bridge/Dex/extension stack, while Search Monitor supplies the EveOS-facing controls and Local Control verifies process ownership. TLO uses the separately managed Local MoE provider and cannot silently start or reconfigure it.

The repository favors domain boundaries over giant shared files. Frontend state, UI, library behavior, Audioflix, WatchFusion, World Book integration, Gemini, and other features live in dedicated module families with explicit integration points.

A repository smoke test enforces a **450 physical-line maximum for first-party code files**. When a source file approaches the cap, responsibility is expected to move into a focused neighboring module rather than allowing the file to grow indefinitely.

## Repository Map

```text
EveOS.html                         Main browser entry point
css/                               Core and feature styling
js/config/                         Runtime manifest and load ordering
js/modules/core/                   State, storage, theme, local control
js/modules/ui/                     Dashboard and shared UI orchestration
js/modules/modals/                 Modal templates and interaction logic
js/modules/features/               Nexus, Library, Audioflix, Gemini, World Book, Matrix, WatchFusion, etc.
server/                            Python HTTP runtime and backend services
server_modules/                    Backend service/control helpers
tools/WatchFusion/                 Canonical WatchFusion + bundled VoxelVision integration
tools/Nexus-Browser/                EveOS-owned browser-agent bridge, Dex runtime, unpacked extension, and tests
tools/Piano-Auto-Player/           Complete integrated Piano Automation tool
tools/World-Book/                  Complete World Book + Reader Library tool
tools/World-Book/tools/World-Portal/ Connected World Portal tool
tools/smoke/                       Focused regression and integration tests
tools/audit/                       Repository, asset, reference, and safety audits
tools/batch/                       Windows launch/control helpers
tools/legacy/                      Retired migration/fix artifacts
docs/                              Development docs and public screenshots
data/                              Templates and runtime-oriented data roots
```

For a deeper implementation tour, see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Project Size

Use the repository's scanner instead of hand-counting lines:

```powershell
npm run smoke:file-size
# Direct equivalent:
node tools/smoke/first_party_file_size_smoke.js
```

The scanner returns `FIRST_PARTY_FILE_SIZE_SMOKE_OK` with `measuredFiles`, `totalLines`, `averageLines`, `byExtension`, and the largest source file. It counts physical lines in first-party JavaScript, ES modules, CSS, HTML, Python, PowerShell, and batch files. It excludes dependencies, virtual environments, generated runtime data, vendor trees, the external Nuvio installation, bundled VoxelVision, and independently maintained imported tools. It also fails if any scanned first-party source file exceeds **450 physical lines**.

**Measured EveOS 0.7.0 baseline (September 24, 2026; commit `7ccd0386`): 505,803 physical lines across 3,234 first-party source/test files**, averaging 156.4 lines per file. The verified `FIRST_PARTY_FILE_SIZE_SMOKE_OK` breakdown is: 384,078 JS (2,477 files); 59,063 Python (385); 50,492 CSS (276); 4,209 MJS (21); 3,343 batch (43); 3,016 HTML (18); 1,546 PowerShell (13); and 56 CJS (1). The largest measured source is `tools/Nexus-Browser/dex/server-scheduler.js` at 450 lines, exactly the per-file hard cap. These counts describe this measured commit, not a permanently current total; rerun the command above after changes.

The earlier README snapshot recorded **442,915 physical lines across 2,870 first-party source/test files** and is now a historical reference. Changed first-party files have a stricter 440-line headroom guard in the structural preflight.

## Verification And Development Safety

The default development path is **structural preflight → the smallest affected deterministic profile → one final uncached verification**. Generated asset references must already be synchronized before the guardrails pass; final verification is not a substitute for reviewing stale generated assets.

```powershell
# From the repository root
npm ci
npm run --silent test:guardrails
npm run --silent smoke:nexus-browser
npm run --silent smoke:nexus-browser-security
npm run test:ai-control
npm run smoke:file-size
npm run verify
```

| Command | What it checks |
| --- | --- |
| `npm run --silent test:guardrails` | Stale asset references, zero-backlog smoke registry, complete coverage map, file-growth headroom, and the 450-line hard cap. |
| `npm run --silent smoke:nexus-browser` | Focused Nexus Browser service, UI, bridge, and deterministic imported contracts. |
| `npm run --silent smoke:nexus-browser-security` | Bridge origin, private runtime exclusions, and other Nexus security contracts. |
| `npm run test:ai-control` | The broader AI-control profile for Search Monitor, Agent Nexus, TLO/Local MoE, and Nexus Browser. |
| `npm run --silent test:smoke` | Deterministic fast profile; reuse is allowed only when the exact source/environment fingerprint matches. |
| `npm run test:deep` / `npm run test:security` | Broader subsystem or security-sensitive regression profiles when the edit warrants them. |
| `npm run verify` | Final **uncached** repository gate once coherent changes are ready. |
| `npm run smoke:file-size` | Exact first-party LOC totals and per-file 450-line enforcement. |

For operator-visible evidence, use the existing handoff runner (substitute the real pre-change commit SHA):

```powershell
npm run test:handoff -- --base <previous-sha> --profile ai-control --final
```

The handoff runner records exact HEAD/branch alignment, worktree status, changed files, tool versions, local listeners, durations, and bounded failure context under ignored `data/runtime/smoke-results/`. The `--final` option runs the uncached final gate. Use `--allow-branch`, `--allow-diverged`, or `--allow-dirty` only when that state is intentional and documented.

For real owned-runtime/browser qualification, `npm run runtime:search-monitor:qualify` is opt-in and requires the correct local browser, models, service processes, and profiles. Deterministic passing checks alone do not prove live external providers or native audio. Keep actual credentials and private state out of commits.

## Current Project Status

**Verified locally on Windows for the 0.7.0 source checkpoint (September 24, 2026, `7ccd0386`):** 27 focused Dex/Antigravity/diagnostics tests passed; the root Nexus Browser smoke completed 3/3; the Nexus security smoke passed; the AI-control profile completed 12/12; and structural guardrails passed, including 393 registered smoke entry points and the measured 3,234-file/505,803-line size scan. The `npm run extension:reload` command also reported an actual extension disconnect/reconnect cycle. The subsequent README-size update and this documentation work do not change runtime code.

**Not yet established by those results:** the full uncached `npm run verify` gate for this checkpoint, authenticated headed-provider round trips, or successful attachment/send/capture to an already-running Antigravity TUI (Astro). Mocked existing-terminal discovery tests do not substitute for the real Windows console probe. Agent permission scope, Local Control ownership, exact-once/capture-only recovery, and service lifecycle require continued live qualification. Keep the former POC as a comparison source until the [Nexus Browser integration checklist](docs/NEXUS-BROWSER-INTEGRATION.md#delete-readiness-boundary) is complete.

EveOS is actively evolving. The surface area is large and several features depend on external providers, browser behavior, Windows-native APIs, optional local services, or model/tool availability.

Expect some boundaries:

- online media can still disappear upstream;
- Spotify/YouTube/Instagram, Nuvio/addon sources, WatchFusion media providers, and metadata providers can change behavior;
- browser security restrictions differ between `file://` and localhost;
- native audio and target-window automation are especially Windows-specific;
- AI transcription and generation quality depends on the models and source material;
- optional dependencies may require one-time setup or repair;
- experimental areas can be rougher than the core archive/dashboard workflows.

Use disposable or backed-up data when evaluating major import/restore paths, keep credentials out of commits, and run the nearest focused smoke before broad verification.

## A Passion Project

EveOS is a passion project. It is not a product, a startup, or a roadmap promised to anyone. It exists because building a personal environment that can keep evolving is itself useful.

That shapes the repository. Some areas are polished far beyond what a normal product scope would justify because they mattered at the time. Other areas stay rough until they become important. The commit history includes experiments, migrations, wrong turns, rewrites, and integrations that eventually found a permanent home inside EveOS.

You are welcome to read it, run it, fork it, reuse ideas from it, or build something different from it. The most useful way to judge the project is as a workshop that is actively worked in, not a showroom pretending to be finished.

## License

EveOS is available under the [MIT License](LICENSE). Third-party/upstream components remain subject to their own licenses; WatchFusion-specific notices are recorded in [`tools/WatchFusion/THIRD_PARTY_NOTICES.md`](tools/WatchFusion/THIRD_PARTY_NOTICES.md).