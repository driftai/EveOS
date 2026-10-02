# Nexus Browser integration

Nexus Browser is the EveOS-owned integration of the public Browser-AI-Bridge-POC core audited at `8d61115dae63cf94a2a8a236f727c172e0ca7f99`. The original POC is a comparison source only; EveOS does not execute files from it.

## Ownership map

| Layer | Owner | Contract |
| --- | --- | --- |
| Search Monitor surface | EveOS | Agent Nexus navigation, embedded/degraded UI, explicit actions |
| Lifecycle and terminal policy | EveOS Local Control | setup/start/stop, console preference, verified PID ownership, Global Stop |
| Port | EveOS registry | `NEXUS_BROWSER_PORT`, currently 9088 |
| Runtime state | EveOS runtime data | ignored `data/runtime/nexus-browser/` |
| Bridge, Dex, durability | Nexus Browser runtime | exact-target routing, serialized rooms, exact-once ledger, recovery, diagnostics |
| Provider control | EveOS extension source | scoped provider adapters for authenticated browser tabs |
| Agent profiles | EveOS Agent Management | private local store; never copied wholesale into browser transport |

The Node/WebSocket runtime remains a separate process because browser transport, supervision, and restart isolation are useful boundaries. EveOS owns its policy and lifecycle instead of merging the server into the main 8765 process.

## Integrated source

- `tools/Nexus-Browser/server.js` and `server-http.js`: local bridge, diagnostics, static UI, and WebSocket origin policy.
- `tools/Nexus-Browser/dex/`: room scheduler, recovery, exact-once turn ledger, incident evidence, provider-control routing, and managed workers.
- `tools/Nexus-Browser/local-targets/`: existing/spawned terminal-agent adapters.
- `tools/Nexus-Browser/extension/`: unpacked MV3 extension and provider adapters.
- `tools/Nexus-Browser/tests/`: imported public behavior and reliability contracts.
- `server_modules/nexus_browser_control.py`: EveOS lifecycle and process-ownership adapter.
- `js/modules/gemini/search_monitor/nexusBrowser.js`: embedded Agent Nexus surface.

The source merge imported code and public tests only. Private notes, rooms, PIDs, logs, browser profiles, sessions, credentials, downloads, and `.browser-ai-bridge` state are never part of Git. A separate, opt-in, local-only room migration is described below.

## Private data boundary and room migration

- `data/runtime/nexus-browser/dex-state.json` holds private Dex rooms, participants, and transcripts. The browser keeps a localStorage mirror for its own origin, but localhost is the durable room store and owns active relay/recovery fields.
- `data/runtime/nexus-browser/dex-turn-ledger.jsonl` and `incidents.jsonl` are runtime-only dispatch and diagnostic records. They are not datapacks or portable defaults.
- `data/runtime/agent-management/agents.json` separately holds Agent Management profiles, scopes, and provider bindings. It is not a transcript store and Nexus Browser does not silently copy chats into it.
- Both runtime directories and legacy `.browser-ai-bridge/` folders are Git-ignored. The Nexus security smoke also fails if either private runtime tree is tracked. Only schema, implementation, safe examples, and tests belong in the repository.

To import rooms from an old local build, use `node tools/Nexus-Browser/scripts/import-legacy-rooms.js --source <absolute legacy folder>` for a dry run. Stop the EveOS-owned Nexus Browser service, repeat with `--apply`, then start it again from Search Monitor. The importer keeps the source untouched, refuses active/conflicting room state, backs up the current EveOS snapshot under ignored `migration-backups/`, preserves room/message IDs, and verifies written counts. Stale recovery markers are normalized without deleting transcripts. Re-running the import does not duplicate already imported rooms. Do not copy the old `.browser-ai-bridge` directory wholesale; its logs, stale PIDs, and dispatch ledger are not portable room data.

## Lifecycle and process safety

Opening Agent Nexus performs a passive status read only. Start is explicit. The controller launches the deterministic supervisor with the authoritative registry port and routes all mutable runtime state to `data/runtime/nexus-browser/`.

Stop acts only on a supervisor PID whose command line contains both the canonical EveOS tool root and `bridge-supervisor.js`. A healthy runtime without that verified identity is reported as external and is not killed. Global Stop asks Nexus Browser to stop before EveOS localhost and Local Control exit.

Console visibility follows the shared Local Services preference. Headed is the default; headless hides only the local runtime console and does not pretend provider tabs are headless browser automation.

## Extension migration

The canonical unpacked extension is:

```text
tools/Nexus-Browser/extension
```

Its generated `runtime-config.js` is derived from `config/eveos-ports.json`. The manifest does not request `<all_urls>`; it lists only loopback and supported provider origins. Existing browser installations must be repointed once with **Load unpacked** to this EveOS directory before the old POC folder can be deleted.

## Runtime and compatibility configuration

Prefer the `NEXUS_BROWSER_*` environment names. Legacy `BROWSER_AI_BRIDGE_*` names remain accepted where needed so an existing local setup does not break during migration. `NEXUS_BROWSER_PORT` and `NEXUS_BROWSER_DATA_DIR` are injected by EveOS Local Control.

The authoritative defaults are:

```text
http://127.0.0.1:9088/
data/runtime/nexus-browser/
```

## Output-efficient verification

`npm run --silent smoke:nexus-browser` runs the focused lifecycle, surface, and imported public contract suites with one passing summary line. Full failure detail is saved under ignored `data/runtime/smoke-results/`. The root fast/deep/security profiles include the focused Nexus Browser gates, while `npm run verify` is the final uncached repository gate.

This preserves the source project's deterministic reliability coverage while applying EveOS's bounded-output, fingerprint-aware smoke policy. It does not reduce assertions or hide failures.

## Verified versus pending qualification (September 24, 2026)

The Windows 0.7.0 source checkpoint passed 27 focused Dex/Antigravity/diagnostics tests, all structural guardrails (including 393 registered smoke entry points), the Nexus integration smoke (3/3), the Nexus security smoke, and the AI-control profile (12/12). The unpacked-extension reload command reported a completed reconnect. These are locally reported checks, not evidence of an authenticated provider exchange or successful attachment to a live existing Antigravity terminal.

Still pending: headed-provider send/capture, direct existing-Antigravity TUI probe/send/capture without spawning a replacement process, owned supervisor start/stop and Global Stop confirmation for the current checkpoint, and the complete uncached `npm run verify` run. A static passing test is not a substitute for any of these live checks.

## Embedded workspace connection stability

The EveOS host treats the embedded Nexus iframe as a persistent runtime surface. Runtime
URLs are canonicalized before comparing or assigning `iframe.src`, so equivalent URLs
such as `http://127.0.0.1:9088` and `http://127.0.0.1:9088/` cannot trigger a reload
on every status render.

A transient Local Control/status miss also preserves a last-known-running Nexus iframe
instead of replacing it with `about:blank`. Only a confirmed stopped state or an
explicit Stop action tears the embedded workspace down. This prevents healthy Base/Dex
WebSocket sessions from cycling simply because the host status probe briefly missed.

## Manual Local Control cold-start policy

A `file://` EveOS load is observation-only. `EveOSLocalControl.ensure()` may probe an
already-running loopback controller automatically, but it will not invoke the
`eveos-control://start` protocol unless an explicit user action grants the launch.
Reloading EveOS therefore cannot resurrect Local Control after the user turned it off.

Search Monitor lifecycle buttons are explicit user actions and may cold-start Local
Control when needed. Passive status refreshes and automatic recovery paths may only
observe an existing controller.

## Control-plane ownership during transient health misses

Search Monitor no longer treats one failed `/health` read as proof that port 9088
belongs to another service. The Local Control adapter verifies the listener PID is the
EveOS `server.js` child of the verified Nexus supervisor. That verified process-tree
identity keeps the runtime classified as running while HTTP health recovers, and
`/diagnostics` is still attempted so extension/target counters need not collapse to
zero unnecessarily. An open port with no verified EveOS-owned listener remains blocked
and is never adopted.

## Workspace ownership and reload boundary

Search Monitor may retain more than one historical UI container while views are rebuilt.
Only the currently bound/visible Nexus iframe is allowed to own Base/Dex viewer sockets:
binding a new Search Monitor root puts the previous iframe in handoff standby, and the
newly loaded visible iframe explicitly claims fresh ownership. This prevents hidden
retained Nexus views from cycling socket ownership behind the active workspace.

The handoff snapshot is **detach-scoped**, not a general session restore mechanism.
Detach/reattach preserves Base mode, App-Origin target/binding, transcript/draft/scroll,
and Dex mode/room/view state. An ordinary attached iframe/tool reload starts a fresh UI
session and clears the old handoff snapshot instead of resurrecting prior transcript
cards, old `APP_TARGET_BUSY` errors, or stale rebind notices. A fresh detached owner is
the exception: while the popup owns the lease, a newly loaded embedded standby view
must preserve that live detach snapshot until reattach.

An intentional handoff suspension is displayed as **Workspace standby** rather than
**Nexus reconnecting**. Actual WebSocket reconnect diagnostics include the close code
and reason so transport loss can be distinguished from ownership transfer.

## Deterministic reattach transfer

Reattach no longer depends only on same-origin `localStorage` event ordering. The
detached owner snapshots Base/Dex state at the moment **Reattach to EveOS** is clicked
and includes that snapshot in the detached-state message to the EveOS opener. Search
Monitor forwards the snapshot directly to the embedded Nexus iframe with a
`restore-and-claim` workspace command. The embedded coordinator adopts that exact
snapshot and restores registered Base/Dex clients even if storage ownership events
arrive in a different order.

The deliberate reattach path suppresses the popup's normal unload/closed handoff so a
second late claim cannot overwrite or race the direct restore.

## Detached workspace single-owner handoff

Attached and detached Nexus are two views of one logical workspace, not two concurrent
viewer runtimes. A shared same-origin handoff coordinator maintains one short-lived
ownership lease for the Base/Dex viewer sockets.

Before detach, the embedded view snapshots its Base mode selection, target binding,
visible Base transcript/draft/scroll position, plus Dex mode/active-room/draft/scroll
position. The detached view claims the lease, restores that snapshot, and becomes the
only Base + Dex WebSocket owner. The original iframe stays loaded in EveOS but is hidden
and its viewer sockets are suspended.

**Reattach to EveOS** snapshots the detached view, relinquishes its lease, closes the
popup, restores the latest snapshot into the still-loaded embedded iframe, and resumes
that iframe as sole socket owner. Base App-Origin selection/binding is restored
immediately before reconnect. Dex keeps a deferred desired room ID and reapplies it
after the authoritative localhost room snapshot arrives, so reattach cannot silently
fall back to a different room just because room data arrived later.

Dex room/transcript durability remains localhost-owned;
the handoff snapshot carries viewer position and Base UI state rather than creating a
second room store. Closing/crashing the detached view releases or expires the lease so
the embedded workspace can reclaim ownership.

Clicking **Focus detached** only focuses the existing popup; it never calls
`window.open(...)` again on the named window, so focusing cannot reload the workspace.

## Delete-readiness boundary

The original POC is safe to delete only after all of these are true:

1. deterministic source, lifecycle, surface, and security gates pass from EveOS;
2. EveOS starts exactly one owned supervisor, embeds its workspace, and stops it cleanly;
3. the browser extension is loaded from the EveOS path and reconnects on port 9088;
4. at least one disposable supported-provider round trip proves exact target send/capture;
5. Global Stop leaves no EveOS-owned Nexus Browser listener/process;
6. final `npm run verify` passes and the merger commit is pushed.
7. any wanted private rooms have been migrated and verified locally, and personal notes/configuration in the old folder have been reviewed.

Until then, keep the original POC as a rollback/comparison source. EveOS never mutates or deletes it.
