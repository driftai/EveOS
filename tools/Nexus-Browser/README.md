### Background result delivery (revision 41)

An existing local Antigravity CLI can register a fixed, authenticated
qualification run tied to the exact Dex room, requester, task ID and Git SHA.
After the installed revision-41 supervisor validates it, a detached child
writes a signed report and the server delivers the outcome to the original
Online-Origin tab **outside the Dex relay**, at most once. No task replay on
uncertain delivery; missing or corrupt local credentials fail closed. See
DEX-MODE.md for the CLI and strict bootstrap prerequisites.

### Dex-bound ChatGPT stream recovery (adapter revision 41)

Nexus recognizes both `Error in message stream` and `Stream cache expired` as terminal provider banners, not as plain quoted conversation text. For an exact tab bound to any durable Dex room (including a first-time message or pending HEADSUP), the extension requests localhost authorization, waits up to 30 seconds for unrelated conflicts, and may send **one** same-tab out-of-band continuation. A matching parked `dex-turn-*` recovery is deliberately allowed: stale capture pauses briefly, the continuation final is correlated back to that exact request, and normal recovery/RETURN/DONE/HEADSUP semantics resume without replaying the original prompt. It never blindly retries an already-dispatched command or task, and records unavailable/uncertain sends without loops. This requires supervised revision-41 installation and local qualification; source commits alone do not update the live extension. See DEX-MODE.md.

# EveOS Nexus Browser

This runtime is integrated into EveOS and is normally managed from **Search Monitor -> Agent Nexus -> Nexus Browser**. EveOS owns port 9088, explicit lifecycle, terminal visibility, Global Stop, ignored runtime state, and the embedded workspace. Run it directly only for focused debugging.

Canonical paths:

```text
Extension: tools/Nexus-Browser/extension
Runtime data: data/runtime/nexus-browser
URL: http://127.0.0.1:9088/
```

Rooms, participants, and transcripts are private machine-local state, not repository or datapack content. Agent Management profiles live separately under `data/runtime/agent-management/`; they are not copied into Nexus Browser chat transport. For a safe dry-run/import of rooms from a legacy local build, see `../../docs/NEXUS-BROWSER-INTEGRATION.md`.

The integration's historical source baseline is recorded in `../../docs/NEXUS-BROWSER-INTEGRATION.md`. This directory is the EveOS-owned Nexus Browser implementation.

Standalone localhost bridge for two target classes:

- **Online-Origin Targets** — already-open authenticated AI web chats controlled through the browser extension.
- **Local-Origin Targets** — local CLI/agent sessions reached through the localhost bridge.

The UI keeps the two classes separate. Online browser-tab controls are hidden in Local-Origin mode, and local-agent controls are hidden in Online-Origin mode.

## Online-Origin Targets

Current provider adapters:

- DeepSeek
- Grok
- Claude
- ChatGPT
- Gemini App / Google AI Studio
- Muse

Online targets retain the existing **Target type -> Open chat -> Connect target** flow. Provider-specific DOM behavior lives under `extension/`.

## Dex rooms and agent self-service

Dex Mode binds named participants to exact Online-Origin browser chats or Local-Origin sessions. The localhost scheduler serializes room turns; the headed Dex page is a viewer/controller and can disconnect without owning the live queue, current turn, timeout, or recovery loop.

### Agent-Only Mode and human input

Dex starts in **Agent-Only Mode on every new page load or reload**. Structural human controls are disabled and visually grayed out: new rooms, room identity/settings, participant binding/editing, clear/delete, and manual stop/continue relay. The top banner identifies the mode, and its slowly pulsing red **Enable Human Input** button unlocks eligible controls on the primary, connected Dex viewer. The pulse respects reduced-motion settings. Click **Return to Agent-Only Mode** to relock; the human unlock flag is deliberately not stored.

**Always available in both UI modes:** browsing between rooms, reading transcripts, and typing into the room composer. **Send to room** remains outside the editing lock, but sending still requires the connected primary viewer, a room with participants, and an idle/non-editing relay state; a standby viewer cannot send or mutate. Browsing is allowed on standby pages too. Switching between Base Mode and Dex Mode does not stop localhost-owned relays.

This is **a local browser UI editing gate, not a backend permission change or an agent capability grant**. Bound agents still use their exact-session, exact-room provider-control authorization and busy-state safeguards. A human can opt into room editing without granting an unrelated agent access to it.

A bound Online-Origin agent can request a **server-authorized extension reload** with `[[DEX:CMD {"action":"reload_extension","room":"<exact authorized room id>"}]]`. Only the exact bound browser tab may request it, and all rooms and provider-control operations must be idle. Localhost rejects ambiguous extension sessions, requests one reload, and verifies the acknowledgement plus a new authoritative connection epoch, fresh target snapshot, and new provider-control bridge before returning success. This does **not** expose PowerShell, arbitrary commands, or local-agent privileges. For the initial checkout that installs this feature, use the local `npm run extension:reload` command once; use `npm run extension:refresh` when extension code changes and you want the shared gate before reloading. This update advances the shared content-adapter revision so an already-open ChatGPT/provider tab must refresh to load the new trailing-command watcher; the extension boot helper automatically refreshes active stale provider tabs. Wait until the active conversation returns before issuing a command.

A bound agent can inspect and operate its own authorized Dex rooms without Drift manually copying state between agents. Browser agents use a trailing command marker, while Local-Origin agents can use `scripts/dexctl.js`.

The 2026-09-24 ChatGPT page uses a DIL response renderer and can have no legacy assistant-role or `.markdown` elements. The provider adapter positively recognizes only selection-message containers with a descendant `DilResponseRoot`, preserving the user/assistant boundary rather than scanning arbitrary page text. For a headed failure, inspect the extension's isolated content-script diagnostic snapshot via `BrowserAiBridgeDexProviderControlContent.diagnostics()`; its stage, assistant-node count, and action indicate whether parsing reached background dispatch without logging private reply text. Adapter revision 41 requires a refresh of existing ChatGPT provider tabs after installing this update. The watcher claims one command per assistant message even when DIL block counts change; malformed trailing Dex CMD attempts (including missing closing brackets or spaced delimiters) now generate at most one exact-tab formatting nudge instead of failing silently, with no command execution or automatic retry; the background bridge suppresses repeated action IDs and repeated server result IDs, with count-only diagnostics. Exact reply receipts: append `[[DEX:RETURN:<exact turn ID>]]` to a final Dex agent reply to request prompt-scoped capture, durable final-result buffering, and a localhost commit acknowledgement. RETURN does not add another relay turn or alter DONE; see DEX-MODE.md for syntax and failure semantics. Outgoing heads-up notifications: the finishing agent may append `[[DEX:HEADSUP:Eve]] [[DEX:DONE]]` to ping exactly one named Online-Origin room participant out of band without another relay turn or automatic acknowledgement; see DEX-MODE.md for cooldown, expiry, deduplication and delivery status. One-shot DONE subscriptions: `send` accepts `notifyOnDone:true` with optional `notifyMember`. The online sender may rearm independently with `watch_done` or disable via `unwatch_done`. A matching DONE stops the room and generates a separate at-most-once provider notification without scheduling a Dex relay turn; see DEX-MODE.md for the distinction between a Dex turn and provider model usage. A control result appearing in ChatGPT's composer is not proof it was sent: the bridge now records explicit negative adapter acknowledgements as `DEX_RESULT_SUBMISSION_FAILED`, without automatically replaying an uncertain submission. If `draftLength` is near zero when diagnosing, the send button may legitimately be absent; inspect button state while the full draft is present before changing selectors.

The onboarding command is intentionally read-only:

```text
[[DEX:CMD {"action":"onboard"}]]
```

or locally:

```text
node scripts/dexctl.js onboard --agy-pid <pid> [--room "<room>"]
```

It returns the agent's room identity, participant/provider summary, available room-control actions, and the important operating boundaries. In particular, an Online-Origin agent gains Dex control through its browser chat but does **not** automatically gain direct access to Drift's localhost, filesystem, or private repositories.

Agents should query `rooms`, `targets`, or `status` only when needed rather than continuously dumping bridge state into quota-limited chats. Dex relay context is bounded by design; agents should ask for missing project context instead of assuming unseen history.

Other current room-control actions include `create_room`, `use_room`, `add_agent`, `spawn_agent`, `despawn_agent`, `clear_chat`, `delete_room`, and `send`. Destructive room actions are authorization- and busy-state-guarded.

For qualified provider types, an Online-Origin parent can use `spawn_agent` to create a brand-new background browser chat, bind that exact tab as a managed Dex participant, delegate work through the normal localhost scheduler, and later use `despawn_agent` to remove the participant and close its exact tab. The initial managed-worker surface is intentionally limited to ChatGPT and Muse. The feature does not grant shell access or arbitrary browser automation; localhost remains the orchestration authority and the extension only owns the concrete tab lifecycle.


## Local-Origin Targets

The current local target type is **Terminal Agent**.

Local terminal targets now have an explicit session origin:

1. **Existing Session** — preferred when Nexus Browser can attach to an already-running interactive agent terminal.
2. **Spawned Session** — fallback owned by Nexus Browser when no attachable existing terminal is available or the user intentionally selects it.

The target list sorts Existing Sessions before Spawned Sessions.

## Existing Session: already-running Antigravity TUI

On Windows, Nexus Browser looks for interactive `agy.exe` processes that are already running and are not headless/stream-json jobs. Each candidate is probed with the Win32 console APIs before it is exposed as a target.

A successful target looks like:

```text
Antigravity CLI · Existing Session · PID <pid>
```

Its transport is:

```text
windows-console-attach
```

This path does **not** start another Antigravity agent process. The bridge attaches a short-lived helper to the existing console, injects the prompt into that console's input buffer, and reads the visible console screen back while the native Antigravity TUI remains the control surface.

The helper uses `AttachConsole`, `CONIN$` / `CONOUT$`, `WriteConsoleInput`, and console-screen reads. It does not use OS-global `SendInput`, clipboard automation, foreground focus stealing, or mouse automation.

Important: current Antigravity releases support official **Remote Control** companion UIs for interactive CLI sessions, which confirms that one visible CLI session can have another control surface. However, Google's public CLI docs do not expose a stable third-party local IPC contract that Nexus Browser can call to take over an arbitrary already-running plain TUI. For the no-restart case, Nexus Browser therefore uses a Windows console-attachment experiment and only advertises processes that actually pass the attach probe. A future Remote Control adapter should replace this low-level path if Google documents a stable local protocol for third-party clients.

### Existing-session safeguards

Before injecting a prompt the adapter requires the captured Antigravity screen to be at an empty `>` prompt. If the agent is generating or the user has an unsent draft in the native TUI, the bridge refuses the send instead of mixing input.

Browser-originated prompts are normalized to one line before console injection. The native TUI remains visible and should show the injected prompt and resulting work exactly where the user was already working.

Response capture is based on the visible Antigravity console screen. Very long responses that have already scrolled out of the visible console may need a richer terminal-capture transport.

Set this only to disable existing-session discovery:

```text
NEXUS_BROWSER_ATTACH_EXISTING=0
```

## Spawned Session: bridge-owned Antigravity fallback

When `agy` is on PATH, Nexus Browser also exposes:

```text
Antigravity CLI · Spawned Session
```

This is explicitly a **spawned session**, not a continuation/attachment to another terminal.

The bridge owns one long-lived process:

```text
agy --input-format stream-json --output-format stream-json
```

Prompts are written as NDJSON user events to that process's stdin. Antigravity emits `init`, `step_update`, and `result` events on stdout. Response deltas become transcript updates and completed tool steps become Nexus Browser activity events.

The process remains alive between turns, so later prompts reuse the same warmed conversation instead of spawning repeated `agy --continue` processes.

### Spawned sessions are visible by default on Windows

The underlying stream-json process still uses pipes because that is the supported programmatic transport, but Nexus Browser no longer leaves the user with an invisible session. On the first spawned turn it automatically opens the companion console (`CONSOLE.bat`) on Windows.

The companion console is a visible frontend to the exact same broker-owned Antigravity process; it does not start another `agy.exe`.

Disable only for automation/CI:

```text
NEXUS_BROWSER_SPAWN_VISIBLE_CONSOLE=0
```

The console can also be opened manually:

```text
CONSOLE.bat
```

or:

```text
npm run console
```

Console commands:

```text
/status
/quit
```

`/status` reports broker state such as running/busy state, queue depth, PID, and active conversation ID when available.

## Legacy Gemini CLI fallback

The original `Gemini CLI · latest repository session` adapter remains in source as a diagnostic fallback. When any Antigravity target is available, the legacy Gemini target is hidden by default.

For diagnostics only:

```text
NEXUS_BROWSER_SHOW_LEGACY_GEMINI_CLI=1
```

The legacy adapter still uses the old short-lived resume strategy and is not a preferred Local-Origin transport.

## Multi-client Local-Origin behavior

Each browser/console WebSocket connection keeps its own Local-Origin target selection. One client selecting a target does not silently change another client's selection.

Clients attached to the same target share target output. Spawned-session prompts are serialized by the persistent broker so only one turn writes to the managed Antigravity process at a time.

Existing-session injection is also guarded per PID so Nexus Browser will not send two simultaneous prompts into the same native TUI.

## Architecture

```text
                               Local-Origin
                                    |
                      +-------------+--------------+
                      |                            |
             Existing Session               Spawned Session
                      |                            |
          already-running agy.exe       bridge-owned persistent agy
          native Antigravity TUI        stream-json process
                      |                            |
          Win32 console attach          browser + visible companion
                      |                            |
                 Browser UI <------ Nexus Browser ------> CONSOLE.bat

Online-Origin continues separately through the browser extension and web tabs.
```

Key files:

- `server.js` — HTTP/WebSocket relay and per-client Local-Origin selection.
- `local-targets/manager.js` — Local-Origin registry, dynamic targets, session-origin ordering, adapter status.
- `local-targets/antigravity-existing.js` — discovery/attach/capture for already-running Antigravity TUI processes on Windows.
- `scripts/win-console-bridge.ps1` — short-lived Win32 console attach/input/snapshot helper.
- `local-targets/antigravity-cli.js` — spawned persistent Antigravity fallback and turn queue.
- `local-targets/gemini-cli.js` — legacy Gemini CLI diagnostic fallback.
- `scripts/local-agent-console.js` — visible frontend for the spawned broker session.
- `public/app.js` — browser target selection, transcript, and prompt routing.
- `extension/` — online provider discovery and browser adapters.

## Safety / lifecycle rules

- Existing-session input uses the target console input buffer, not OS-global keystrokes.
- Existing-session attach never intentionally launches another `agy.exe`.
- Existing-session sends require an empty native Antigravity prompt.
- Spawned-session prompts use stdin, not shell command arguments.
- `--dangerously-skip-permissions` is not enabled by default.
- Spawned-session turns serialize through one broker queue.
- Managed spawned children stop when Nexus Browser closes.
- First-party text/code files must stay at or below 450 physical lines.

## Run

Install dependencies once:

```text
npm install
```

Start the bridge under the visible deterministic supervisor:

```text
START.bat
```

or:

```text
npm start
```

The supervisor keeps the localhost server alive and restarts it after repeated health failures without involving an LLM. Use `npm run start:raw` only when intentionally debugging `server.js` without supervision.

Compact deterministic health/status:

```text
npm run doctor
```

Quota-saving qualification:

```text
npm run qualify -- --area muse --full
npm run qualify -- --area recovery --full
npm run stabilize
```

`npm run stabilize` runs the focused resilience bundle and the normal Windows verification gate in one deterministic pass, writing detailed output to disk instead of requiring an agent to narrate every command.

Detailed qualification output is written under `data/runtime/nexus-browser/qualification/`; the console prints only a compact PASS/FAIL summary.

Use [LIVE-QUALIFICATION.md](./LIVE-QUALIFICATION.md) for the provider-neutral live contract and the retained Muse, DeepSeek, and Windows terminal follow-up checks.

### Canonical engineering workflow

The durable efficiency/reliability rules live in [ENGINEERING-EFFICIENCY.md](./ENGINEERING-EFFICIENCY.md). Use that file as the canonical change/qualification workflow instead of reconstructing commands from old chat logs.

New-chat / agent-rollover handoff:

```text
npm run handoff
```

Before intentionally promoting one Eve Engineering chat to the next, prefer the strict rollover gate:

```text
npm run handoff:verify
```

The strict form fetches `origin/main`, requires branch `main`, a clean worktree, and local HEAD equal to the freshly fetched `origin/main`. It emits the packet even on mismatch, but exits non-zero so a dirty/diverged checkout cannot be silently presented as authoritative.

The handoff packet includes current repo state, live Dex/runtime state, recovery/durability state, recommended next action, the canonical qualification contract, and the **Eve Engineering N** lineage contract. That lineage contract carries source-of-truth precedence, durable Library workflow pointers, anti-bloat order, Eve-first/local-proof division of labor, evidence-return requirements, exact-state completion receipt requirements, production-continuity protections, and the fields a new engineer should ground before speculative edits. A fresh engineering chat should read this packet instead of reconstructing the project from old chat history.

Normal shared gate:

```text
npm run validate:shared
```

Preferred one-command gate + Chrome extension reload after extension runtime changes:

```text
npm run extension:refresh
```

`extension:refresh` runs `npm run validate:shared` first and only then runs `npm run extension:reload`.

The lower-level reload-only command remains:

```text
npm run extension:reload
```

That alias uses `scripts/dexctl.js reload-extension`, waits for a real extension disconnect -> reconnect cycle, and should be preferred over raw WebSocket one-liners. Agents should use the automated npm commands before asking Drift to reload the unpacked extension manually.

Open:

```text
http://127.0.0.1:9088
```

## Verification

At the EveOS 0.7.0 source checkpoint on September 24, 2026, Windows validation passed the root Nexus smoke (3/3), security smoke, AI-control (12/12), guardrails, and 27 focused Dex/terminal/diagnostics tests; a subsequent `extension:reload` reported an actual reconnect. These source/transport checks **do not** establish a successful attached Antigravity TUI turn or a complete authenticated provider qualification. Run the live checklists below before claiming those paths work on a particular machine.

Windows:

```text
VERIFY.bat
```

Cross-platform source tests:

```text
npm test
```

### Existing-session live proof

1. Start an ordinary visible Antigravity TUI yourself with `agy` in the workspace you are actually using.
2. Leave it idle at an empty `>` prompt.
3. Start Nexus Browser and select **Local-Origin Targets -> Terminal Agent**.
4. Refresh local targets.
5. Confirm an **Antigravity CLI · Existing Session · PID ...** target appears for the already-running TUI.
6. Connect it and send a unique prompt from Nexus Browser.
7. Confirm the prompt visibly appears in that same native Antigravity TUI, no second `agy.exe` is created, and the TUI performs the turn.
8. Confirm Nexus Browser captures the visible answer as the reply.
9. Type a message manually in the TUI and verify the bridge does not corrupt or steal the draft.
10. While the TUI is busy, verify Nexus Browser refuses another injected prompt instead of interleaving it.

### Spawned-session live proof

1. Select **Antigravity CLI · Spawned Session**.
2. Send a prompt and verify exactly one managed stream-json `agy.exe` starts.
3. Confirm a visible companion console opens automatically on Windows.
4. Send a second context-dependent prompt and confirm the same PID/conversation ID persists.
5. Send two prompts close together and verify serialization.
6. Stop Nexus Browser and confirm no managed `agy.exe` remains orphaned.

## Known limitations

- Antigravity officially supports Remote Control companion UIs for interactive CLI sessions, but the public CLI docs do not currently document a stable third-party local IPC/API that Nexus Browser can directly reuse for an arbitrary already-running TUI.
- Existing-session control uses Windows console attachment without restarting the target. Windows Terminal/ConPTY behavior must be proven locally rather than assumed.
- If Google exposes a documented local Remote Control protocol, that should become the preferred attached-session transport while keeping this console adapter as a compatibility fallback.
- Existing-session reply extraction currently reads the visible console surface; output that has already scrolled away may not be recoverable by this adapter.
- Spawned Session remains available because it provides a reliable supported programmatic fallback when a native terminal cannot be attached.
- Legacy Gemini CLI may be unusable for accounts migrated to Antigravity.
- Provider websites can change their DOM and require online-adapter maintenance.


### Localhost durability and fast-path runtime

Dex now pushes more routine work into the deterministic localhost bridge instead of requiring a local LLM:

- A durable append-only turn ledger records the dispatch boundary before a prompt can cause a provider/local side effect. After a crash, reliable ledger evidence decides between safe replay (never dispatched) and capture-only recovery (dispatch may have happened).
- Room snapshots are repaired for known invariant failures and mirrored through atomic localhost state. Localhost preserves server-owned runtime fields/messages if a reconnecting browser sends a stale room mirror.
- Recent queued relay work is represented by durable `pendingTurn` state and consumed directly by the localhost scheduler; a browser page reload is no longer part of execution recovery.
- Localhost owns round-robin scheduling, relay-budget consumption, exact provider-target selection/restoration, turn timeouts, bounded retry decisions, and interrupted-turn capture recovery.
- One headed Dex page remains the primary **controller** for room-edit writes. Extra Dex tabs are standby/inert for mutations, but losing the controller does not interrupt relay execution.
- Stale WebSocket clients are evicted by heartbeat. Active/recovering rooms continue headlessly; the Dex UI is only auto-opened when a provider/local agent needs the room-control surface.
- Exact bound provider targets can be reused or reopened at their saved URL with `active:false`. Missing local targets get one forced rediscovery pass before failing.
- Known transient errors use a bounded deterministic failure policy. Unknown failures are written as compact incident packets under `data/runtime/nexus-browser/incidents.jsonl`.
- Existing-session Antigravity snapshot polling is asynchronous so PowerShell capture no longer stalls the Node event loop. Local-target discovery has a short cache, provider adapter readiness has a short TTL, and healthy repeated sends avoid redundant probes.

Runtime files:
- `data/runtime/nexus-browser/dex-state.json` — compact durable room snapshot
- `data/runtime/nexus-browser/dex-turn-ledger.jsonl` — dispatch/idempotency ledger
- `data/runtime/nexus-browser/incidents.jsonl` — bounded incident evidence

The project intentionally keeps the current JSON/JSONL localhost persistence instead of adding a native SQLite dependency. It preserves Node >=18 compatibility and avoids a new install/runtime surface while the state volume is small. A future migration can use a modern SQLite build if room/history volume eventually justifies it.
