# App-Origin Targets

App-Origin is Nexus Browser's desktop-application target class. It is separate from
Online-Origin browser tabs and Local-Origin terminal/CLI sessions.

The first provider is **ChatGPT App** on Windows.

## Architecture

ChatGPT App Mirror is still an Online-Origin target because it controls an authenticated
`chatgpt.com` browser conversation. App-Origin instead drives the actual running
desktop application:

```text
Nexus / Dex localhost scheduler
        |
        v
App-Origin target manager
        |
        | Microsoft winapp CLI / Windows UI Automation
        v
ChatGPT Windows app
        |
        +--> verified composer
        +--> verified Send control
        +--> accessible response observation
        |
        v
Nexus transcript / Dex room
```

The ChatGPT target is published as:

- target class: `app-origin`
- target type: `desktop-app`
- provider: `chatgpt-desktop`
- provider name: `ChatGPT App`
- transport: `windows-uia-winapp`
- session origin: `existing-app`

No private ChatGPT API is used.

## Control targeting invariants

The native ChatGPT controls are dynamic. Nexus does not trust a fixed selector or a
generic arrow button.

Composer selection combines semantic evidence, keyboard-focusability and lower-window
geometry. Sidebar search/title fields are rejected. Send selection requires explicit
Send/Submit semantics or a small button geometrically adjacent to the verified
composer. This prevents a top navigation/back arrow from being treated as Send.

Nexus prefers UI Automation `set-value` and `invoke`. If programmatic value-setting
is unavailable, it explicitly focuses the verified ChatGPT composer before using
keyboard input. If a trustworthy composer/Send path cannot be established, it fails
closed.

## Reply extraction

A ChatGPT reply may be exposed as several accessibility nodes rather than one element.
The adapter therefore treats role markers such as `ChatGPT said` / `You said` as
conversation boundaries. During an active send it does not merely take the newest-looking
assistant section: it matches the exact injected user prompt and accepts only the assistant
turn paired with that prompt. Once role markers are present, geometric fallback is not
allowed to substitute an unrelated older response.

The grouped reader:

- preserves paragraph and accessible line breaks;
- supports text, paragraph, heading, list-item and leaf document nodes;
- excludes the exact user prompt and baseline text that existed before dispatch;
- excludes known native UI chrome, including `Latest response`,
  `ChatGPT is responding`, and the disclaimer footer;
- falls back to geometric single-node scoring only when role-group extraction is not
  available.

This matters for long native replies: selecting only the highest-scoring text node can
silently reduce a multi-paragraph answer to one paragraph. Fast polling inspects only
visible nodes, but immediately before final delivery Nexus performs one full
offscreen-inclusive accessibility snapshot and upgrades the candidate only when that
full reply safely contains the visible tail. A tightly bounded document/root aggregate
may repair split UIA leaf fragments only when it contains the already prompt-correlated
fragment; large whole-conversation documents are rejected. Capture Latest uses the same
full reconstruction path. The expensive full-tree scan is therefore not performed on
every 180 ms poll.

## Passive native-turn ingestion

Base Mode now has a passive receiver for completed native ChatGPT turns that were not
initiated by the currently running Nexus request. This covers manual messages typed
directly in the ChatGPT Windows app and late replies that finish after the active
request reader has stopped.

The receiver is deliberately not a "latest text" poller. It uses the same role-group
reader as active capture to reconstruct complete user/assistant turns, derives a
privacy-safe SHA-256 native-turn fingerprint, scopes it to the immutable bound
process/window/conversation proof, and compares that delivery fingerprint against a
bounded durable seen-turn ledger. The ledger stores fingerprints and delivery state,
never prompt/answer text. This prevents identical prompt/reply text in two explicitly
rebound native chats from contaminating each other's dedupe history.

Important invariants:

- a fresh/manual binding creates a stable opaque delivery scope and seeds everything already
  visible as baseline, so old history never floods the transcript;
- automatic server reconnect preserves that delivery scope plus a durable native-turn cursor,
  so unchanged history produces no events while a genuinely newer turn after the cursor can
  still be delivered once;
- on every steady-state scan, Nexus considers only turns strictly after the durable cursor;
  previously hidden/offscreen historical turns that become newly visible before that cursor
  remain baseline history and are never emitted;
- if the old cursor has been virtualized out of the accessible history, Nexus resynchronizes
  by baselining the currently visible turns instead of guessing and replaying history;
- active Nexus/Dex finals and Capture Latest seed the same fingerprint ledger/cursor, so passive
  observation cannot deliver the same native answer a second time;
- a pending passive event is marked delivered only after the Base UI ACKs its fingerprint;
- process/window changes and native conversation changes fail closed with
  `APP_TARGET_REBIND_REQUIRED`;
- native conversation continuity uses overlap across the rolling set of privacy-safe
  turn anchors rather than requiring one old "latest" anchor forever; this tolerates
  real ChatGPT Windows UI virtualization/reflow while an unrelated anchor set still
  fails closed;
- the continuity window ratchets forward separately from the immutable delivery scope,
  so UI virtualization cannot create a new dedupe namespace or duplicate a reply;
- reconnecting Base Mode may restore its selection only when the previously bound native
  identity still matches; otherwise the user must reconnect explicitly;
- the watcher runs only for a selected Base Mode app target, backs off when no subscriber
  exists, and skips UIA reads while the active app send lease is held;
- passive delivery uses the full offscreen-inclusive reconstruction path, so long
  multi-paragraph/list answers are not reduced to the last visible paragraph;
- a newly observed post-cursor passive turn enters a short stability window before delivery:
  Nexus rechecks it at 350 ms and requires 900 ms of unchanged native-turn fingerprints,
  so a temporarily idle-looking split such as `STABILITY_ / PASSI` cannot escape before
  the native UI exposes `STABILITY_PASSIVE_OK`;
- native role labels such as `You said:` and `ChatGPT said:` are structural UI chrome
  and can never finalize as assistant output, including through the geometry fallback reader.

The passive event is `native_app_turn`. Its stable delivery-scope fingerprint is
also used as the Base transcript DOM identity, making an event retry idempotent if the socket drops between
render and ACK. Passive events are currently surfaced to the selected Base Mode view;
the same primitive can later feed unsolicited Dex routing without conflating it with
ChatGPT App Mirror.

## Supervised restart discovery

`npm run restart` prefers the live `/diagnostics` identity, but a temporary diagnostics
miss no longer causes a false `NEXUS_RESTART_NOT_RUNNING`. On Windows it may fall back
to the port listener PID and then verifies the exact EveOS `server.js` → Node
`bridge-supervisor.js` parent chain (plus the supervisor PID file when needed) before
recycling anything. Ownership mismatch still fails closed.

## Bridge connection failure containment

Nexus server WebSocket commands are guarded at the EventEmitter boundary. A rejected
async command is logged and returned to that client as `SERVER_COMMAND_FAILED`; it does
not become an unhandled rejection that terminates the localhost server. WebSocket sends
also fail closed if the peer closes between the ready-state check and the actual write.

Base/Dex clients reconnect to localhost with a fast bounded backoff (300 ms initial,
capped at 2 seconds) and retain an 8-second visual recovery grace period. In-flight AI
prompts are never blindly resent after a reconnect because the original prompt may have
already reached the provider.

## Latency

Current native response timing is deliberately low-latency but still stable:

- first response poll: 75 ms
- subsequent poll: 180 ms
- normal no-generation settle: 850 ms
- after generation was observed and then ended: 650 ms
- post-send confirmation delay: 80 ms
- semantic composer/Send recovery short-circuits as soon as a verified control is found
- absolute response timeout: 4 minutes

The longer post-generation settle is intentional: the live Windows app can briefly expose
split UIA fragments after its Stop control disappears. Finalization then performs one
offscreen-inclusive reconstruction pass and preserves that full snapshot for the shared
active/passive turn fingerprint, preventing a later passive duplicate.

## Process identity and safety

A Dex App-Origin binding pins the stable target id/provider, concrete Windows
process/window identity, and an exact native-conversation proof. Nexus prefers the
active ChatGPT conversation title when Windows UIA exposes it. When the native header
is not exposed, Nexus falls back to a privacy-safe SHA-256 anchor derived from a
completed user/assistant exchange that is already visible in that conversation. Raw
message text is never stored in the binding.

The live target publishes a bounded set of currently accessible conversation anchors.
The binding advances only when the old and new anchor windows overlap, so aggressive UI
virtualization can roll older anchors away without forcing a false rebind. A disjoint
anchor set still fails closed rather than guessing. If ChatGPT restarts, the
PID/window changes, or the user switches to a different native conversation, the
existing room binding likewise fails closed. Nexus must not silently send a room turn
into a newly-created process or a different conversation just because it has the same
provider name.

Base Mode may reconnect to the currently discovered app normally; the stricter identity
pin is a Dex room execution invariant.

## Exact native conversation identity

Dex App-Origin bindings must include one of two exact native ChatGPT conversation
proofs in addition to process ID and window handle:

1. the active conversation title, when UIA exposes the compact native header; or
2. a hashed completed-turn anchor when the header is not exposed.

The adapter first reads the ordinary UIA tree and performs bounded title/header
recovery. Conversation body text is never re-labeled as a title. Separately, role
markers (`You said` / `ChatGPT said`) can produce a SHA-256 anchor without storing
the underlying prompt or answer. `npm run qualify:app-origin:live` accepts either
proof and fails closed when neither is available; `npm run doctor:apps` remains
usable on the home screen for ordinary diagnostics.

## Base Mode qualification

Base Mode is **live-proven** on the real ChatGPT Windows app.

The confirmed round trip was:

```text
APP_ORIGIN_TEST_003 — Reply exactly with: NATIVE_EVE_OK
        |
        v
native ChatGPT app
        |
        v
NATIVE_EVE_OK
        |
        v
Nexus Base Mode
```

After that, several ordinary conversational turns were also sent through the native
app. Short response capture is therefore proven end-to-end. A later live conversation
exposed that multi-paragraph answers could be truncated to one UIA node; the grouped
reply implementation described above is the fix and should be re-qualified with a
long multi-paragraph reply.

## Dex integration

App-Origin is now wired into the localhost-owned Dex scheduler rather than allowing the
browser viewer to send directly.

The Dex participant builder can discover and bind App-Origin targets. For a scheduled
App-Origin turn the server:

1. resolves the exact bound app target, process/window identity, and native conversation proof;
2. passes through the same durable turn ledger used by Online/Local origins;
3. dispatches through `appTargets.sendAppPrompt()`;
4. consumes native `prompt_accepted`, partial and final events through the scheduler;
5. records the final answer in the room and schedules the next participant normally.

The Dex viewer may request App-Origin discovery/status, but direct viewer
`send_prompt`/selection is refused with `DEX_SERVER_SCHEDULER_OWNS_TRANSPORT`.
This keeps exactly-once authority on localhost. Base Mode and Dex also share a
per-target native send lease: if one path is already driving a specific desktop app,
the other receives `APP_TARGET_BUSY` rather than racing two UI Automation writes and
two response readers against the same window.

Interrupted dispatched App-Origin turns use **capture recovery**, never automatic
prompt replay. Native captures include generation/completeness metadata and must remain
stable before recovery accepts them. Recovery also honors the pinned process/window/conversation identity.

The code path is unit-qualified but must still be live-qualified in an actual Dex room
before being treated as fully production-qualified.

## Current handoff and next live qualification

The 2026-10-01 Base Mode milestone is proven: Nexus submitted a prompt into the
native ChatGPT Windows app and captured `NATIVE_EVE_OK` back into the Nexus
transcript. The native control path, Send action, short reply capture, multi-node reply
reconstruction, app send lease, and localhost Dex routing all have focused regression
coverage.

Run the focused non-destructive qualification after pulling a new App-Origin change:

```powershell
cd C:\Users\alvin\Documents\Workspace\RoughProjDeving\EveOS\tools\Nexus-Browser
npm run qualify:app-origin
```

With the ChatGPT Windows app open, add the live accessibility doctor:

```powershell
npm run qualify:app-origin:live
```

The next unproven boundary is **live Dex execution through App-Origin**. Use a disposable
native ChatGPT conversation and a one-turn Dex room first:

1. Open the exact intended native conversation and refresh App-Origin targets.
2. Bind one Dex participant to **App-Origin → Desktop App → ChatGPT App**. The picker
   may show the active title or **verified native conversation**; the binding must
   contain process, window, and exact conversation proof.
3. Use a one-turn budget and send a unique harmless prompt.
4. Confirm the native app receives the prompt exactly once.
5. Confirm the complete native reply appears in the Dex room exactly once.
6. Confirm no Online-Origin browser tab is selected or used for that turn.
7. Confirm diagnostics show native timing and the room has no leftover recovery or
   pending turn.
8. Only after the single-participant test passes, add a second Online- or Local-Origin
   participant and qualify cross-origin handoff.

If the native conversation proof no longer matches before dispatch, refresh targets and rebind.
If a dispatched turn becomes uncertain, do **not** manually resend it: preserve the
room/recovery state and let capture recovery or the late-final path reconcile it.

## Required helper

Microsoft winapp CLI must be installed on the Windows host:

```powershell
winget install Microsoft.winappcli --source winget
```

Known working host path:

```text
C:\Users\alvin\AppData\Local\Microsoft\WindowsApps\winapp.exe
```

Useful diagnostics:

```powershell
cd C:\Users\alvin\Documents\Workspace\RoughProjDeving\EveOS\tools\Nexus-Browser
npm run doctor:apps
```

The doctor reports control selectors/candidate geometry and grouped reply sizes without
dumping conversation text.

## Lifecycle

Cold-start Nexus in one visible terminal:

```powershell
Start-Process cmd.exe -ArgumentList '/c', '"C:\Users\alvin\Documents\Workspace\RoughProjDeving\EveOS\tools\Nexus-Browser\START.bat"'
```

Recycle only the server child while retaining the existing supervisor terminal:

```powershell
npm run restart
```

The visible supervisor self-registers `data/runtime/nexus-browser/supervisor.pid`
with an exclusive claim and removes only its own PID on exit. `npm run restart`
verifies the live server's actual parent process first; if an older run left a stale
PID-file pointer, the verified parent wins and the PID file is repaired before the
server child is recycled. This lets EveOS recognize
and stop a Nexus instance launched through START.bat while also preventing simultaneous
cold starts from creating two owners. A duplicate START invocation exits when another
healthy supervisor/server already owns the port.

## Failure evidence

Useful App-Origin errors include:

- `APP_BRIDGE_HELPER_MISSING`
- `APP_TARGET_NOT_FOUND`
- `APP_TARGET_BUSY`
- `APP_COMPOSER_NOT_FOUND`
- `APP_INPUT_FAILED`
- `APP_SEND_FAILED`
- `APP_PROMPT_UNCONFIRMED`
- `APP_RESPONSE_TIMEOUT`
- `APP_TARGET_REBIND_REQUIRED`
- `DEX_SERVER_SCHEDULER_OWNS_TRANSPORT`

When a live failure occurs, capture `npm run doctor:apps`, the Nexus diagnostics tail,
what physically happened in the native app, and whether the process/window/conversation identity changed. Do not blindly retry an uncertain dispatched Dex turn.

The existing ChatGPT App Mirror remains an independent Online-Origin comparison/fallback
surface and is not the native App-Origin transport.
