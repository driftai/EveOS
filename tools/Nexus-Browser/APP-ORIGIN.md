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
conversation boundaries and aggregates the newest assistant section in accessibility
order.

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
full reply safely contains the visible tail. Capture Latest uses the same full
reconstruction path. The expensive full-tree scan is therefore not performed on every
250 ms poll.

## Latency

Current native response timing is deliberately low-latency but still stable:

- first response poll: 100 ms
- subsequent poll: 250 ms
- normal no-generation settle: 900 ms
- after generation was observed and then ended: 250 ms
- absolute response timeout: 4 minutes

## Process identity and safety

A Dex App-Origin binding pins the stable target id/provider, concrete Windows
process/window identity, and the active native ChatGPT conversation title. If ChatGPT
restarts, the PID/window changes, or the user switches to a different native
conversation, the existing room binding fails closed and requires a human rebind.
ChatGPT App targets without a detectable active conversation title are allowed in Base
Mode but cannot be committed as Dex participants. Nexus must not silently send a room
turn into a newly-created process or a different conversation just because it has the
same provider name.

Base Mode may reconnect to the currently discovered app normally; the stricter identity
pin is a Dex room execution invariant.

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

1. resolves the exact bound app target, process/window identity, and native conversation title;
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
   must show the active conversation title and the binding must contain process,
   window, and conversation identity.
3. Use a one-turn budget and send a unique harmless prompt.
4. Confirm the native app receives the prompt exactly once.
5. Confirm the complete native reply appears in the Dex room exactly once.
6. Confirm no Online-Origin browser tab is selected or used for that turn.
7. Confirm diagnostics show native timing and the room has no leftover recovery or
   pending turn.
8. Only after the single-participant test passes, add a second Online- or Local-Origin
   participant and qualify cross-origin handoff.

If the native conversation title changes before dispatch, refresh targets and rebind.
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
with an exclusive claim and removes only its own PID on exit. This lets EveOS recognize
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
- `DEX_SERVER_SCHEDULER_OWNS_TRANSPORT`

When a live failure occurs, capture `npm run doctor:apps`, the Nexus diagnostics tail,
what physically happened in the native app, and whether the process/window/conversation identity changed. Do not blindly retry an uncertain dispatched Dex turn.

The existing ChatGPT App Mirror remains an independent Online-Origin comparison/fallback
surface and is not the native App-Origin transport.
