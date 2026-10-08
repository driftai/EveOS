# Nexus Machine Spaces execution ledger

Durable source-of-truth for Machine Spaces and the Dex control path that drives it.
Keep PIDs, tab IDs, drafts, live recovery timers, adapter secrets, and other transient
machine state only in the ignored runtime checkpoint:

`data/runtime/nexus-browser/machine-spaces-checkpoint.json`

## Operating invariants

- Active development branch: `eve/nexus-machine-spaces`. Do not merge or move `main` unless Drift explicitly requests it.
- Never replay an uncertain send, spawn, terminal command, file mutation, supervised job, or provider-control mutation.
- Provider and agent identities are distinct: ChatGPT/Eve, Codex/Nova, Hark/Vera.
- Exact room/member/message/request/control/target/process-epoch/grant/job provenance wins over inferred transcript state.
- Human/local approval gates are not substitutable by provider text.
- Source implementation, automated regression coverage, local qualification, and live qualification are separate states.
- UI participation may be part of a live proof, but UI clicking is not the only supported control surface. Qualification must be terminal-drivable wherever the underlying operation is automatable.
- Commit only coherent source work. Runtime state and credentials stay untracked.

## Current checkpoint

| Field | Value |
|---|---|
| Branch | `eve/nexus-machine-spaces` |
| Post-qualification source HEAD before this ledger update | `437dc749a0838e6463ac5ed8d435c9cf68ec4833` |
| Last independently qualified Machine Spaces source HEAD | `667fb612a66aecd9c45ffa85707e22872a570720` (Vera, Linux ARM64 / pwsh 7.6.6 / headless Chromium) |
| Last Drift Windows qualification | PASS at `0f2960e6f8fb38a720503c6444d2ff064000851f` for the then-current Windows-focused gates |
| Source roadmap | `MS-P0` through `MS-08` now have implementation paths; no known planned stage remains intentionally unimplemented |
| Qualification state | post-`667fb61` source is **not yet independently rerun**; do not describe the current branch as live-qualified until the terminal bundle passes on Drift's machine |
| Main remaining work | run deterministic + Windows + external-adapter + ChatGPT warm-recovery + real-provider provenance qualification and fix any failures found |
| Safe next action | pull current branch, restart Nexus, run `npm test`, then `npm run qualify:machine-spaces:complete`; paste the bounded reports back to Eve |

## Roadmap state

| ID | Status | Source state / remaining proof |
|---|---|---|
| `MS-P0` | source-implemented / live qualification pending | cleanup, exact-origin correlation, rehydration, dedupe, spawn cleanup and terminal-driven real-provider qualification paths exist; no-refresh committed provider result + managed worker exact-once still need the new live bundle run |
| `MS-01` | source-implemented | canonical repo roots + local Allow Once/Persistent/Deny filesystem grants |
| `MS-02` | source-implemented | tree/stat/bounded read/search primitives |
| `MS-03` | source-implemented | hash-guarded create/write/patch/move/delete + atomic writes |
| `MS-04` | source-implemented | capability grants, expiry, revocation and once-use consumption |
| `MS-05` | source-implemented / live quorum pending | Eve/Nova/Vera identity, availability and exact-origin voting wired; terminal provider qualifier drives real Eve/ChatGPT + Vera/Hark when Hark is connected |
| `MS-06` | source-implemented; older supervised flow qualified | start/defer/rebound/interrupt/paging, busy preflight, monotonic leases, process-tree termination and trusted external PID observe/interrupt transport exist; new external-adapter live qualifier still needs Drift run |
| `MS-07` | source-implemented / current UI qualification pending | primary unified terminal/filesystem/supervised request view now uses server-side kind/state/actor/query/live filters, exact provenance and cursor paging with legacy fallback |
| `MS-08` | source-implemented / current bundle pending | destructive/exact-once matrix and native shell probes exist; older Linux/Windows qualification remains evidence, while the current source head still needs rerun |

## Terminal-first qualification model

The acceptance workflow is intentionally usable from PowerShell without manually driving Nexus controls one-by-one.

From `tools/Nexus-Browser`:

- `npm test`
  - full Nexus regression suite;
- `npm run qualify:machine-spaces`
  - deterministic P0/origin/dedupe/spawn/quorum/request-view/trusted-attachment tests plus focused Machine Spaces and native-shell probes;
- `npm run qualify:machine-spaces:external`
  - deterministic bundle + real trusted external PID probe/attest/observe/interrupt/revoke path through the running Nexus server;
- `npm run qualify:machine-spaces:chatgpt`
  - deterministic bundle + assembled-extension reload and warm authenticated ChatGPT exact-once/recovery proof without requiring a manual page refresh;
- `npm run qualify:machine-spaces:providers`
  - disposable real-provider provenance room; uses a fresh ChatGPT worker, verifies exact-origin effect and managed spawn, and runs Eve/Vera quorum when a real Hark target is connected;
- `npm run qualify:machine-spaces:complete`
  - all live Machine Spaces lanes followed by the real-provider provenance qualifier.

Safety behavior of the provider qualifier:

- it uses a disposable qualification room rather than mutating a normal chat room;
- provider-control mutations must still come from genuinely committed provider replies;
- no uncertain provider-control/spawn outcome is retried;
- if outcome becomes ambiguous/unknown, the room is retained and reported for inspection instead of force-cleaned;
- Hark quorum is reported blocked when no genuine Hark target is connected; it is never simulated as a live pass.

## Post-qualification source work after `667fb61`

The following work exists in source but is not covered by Vera's `667fb61` qualification stamp.

### Supervised/job hardening

- monotonic supervision lease generations across defer/rebound;
- busy-target preflight before queued job transitions to running;
- lease-safe cancel/outcome-unknown settlement;
- Windows process-tree termination using `taskkill /T /F` with direct-child fallback;
- exit + short pipe-drain grace so inherited descendant pipes cannot hold a terminal busy forever;
- server-side Human Input interlock for Dex Machine Spaces mutations;
- Dex terminal creation is room-scoped through the gate.

### Trusted external terminal transport

Implemented source includes:

- `machine-spaces/trusted-terminal-attachment.js`
- `machine-spaces/server-controller-trusted-attach.js`
- `machine-spaces/external-terminal-process-adapter.js`
- `scripts/external-terminal-adapter-qualify.js`

Behavior:

- attach/probe a pre-existing external PID;
- pin the exact process start epoch so PID reuse fails closed;
- observe bounded process identity/liveness metadata;
- interrupt the exact process tree;
- Windows interrupt uses tree termination semantics;
- trusted capabilities remain `observe` and `interrupt` only;
- **no external execute capability exists**.

The live qualifier launches only a harmless temporary process, registers a temporary adapter credential, proves exact PID/epoch attestation, observes, interrupts, verifies termination, revokes trust and disables Human Input.

### Primary unified request view (`MS-07`)

Implemented source includes:

- `machine-spaces/request-view.js`
- `machine-spaces/server-controller-request-view.js`
- `public/machine-request-view-ui.js`

Server API:

- `machine_request_view`
- local UI sockets only;
- combines terminal requests, filesystem requests and exact room/space supervised jobs;
- filters: kind, state, actor, query and live-only;
- stable newest-first cursor paging;
- exact request/source-message/actor/terminal/process-epoch/grant/capability/digest/output provenance.

Primary visible UI:

- unified request list is shown after the server successfully answers;
- original request list remains available automatically as a fail-safe during reconnect/unsupported-server conditions;
- filters and Load More are driven by the server projection instead of duplicated browser filtering;
- approval-required terminal cards retain local Allow Once/Deny controls and Human Input gating;
- bounded output pages remain available from the unified cards;
- specialized supervised-job controls may remain as the dedicated Start/Reattach/Interrupt surface even though those jobs also appear in the unified audit list.

Terminal automation covers the server API and companion injection; manual clicking is not required to exercise the deterministic request-view acceptance lane.

## Independent qualification — Vera at `667fb61`

Environment: Linux ARM64, real PowerShell 7.6.6, headless Chromium UI.

PASS:

- `npm test`: 1608 tests, 1590 pass, 18 fail; same 18 baseline failures as `main`, nothing new;
- supervised Start -> running with lease generation 1;
- disconnect -> deferred, same PID, no relaunch;
- reattach -> same PID/process epoch, lease generation 2;
- second reattach refused;
- interrupt -> `outcome-unknown`, no leftover descendants;
- output paging over 3000 lines contiguous;
- browser console clean;
- raw local UI socket receives `MACHINE_HUMAN_INPUT_LOCKED` on Start/Cancel/Reattach while locked;
- busy-target Start -> `MACHINE_TARGET_BUSY`, job remains queued, then runs after target frees;
- POSIX tree-kill passes for `sleep`, `Start-Sleep`, and `/bin/sleep` with no orphans;
- real `pwsh` shell contract: `17/17`.

Not naturally forced live: deliberately unconfirmed-interrupt lease settlement. Unit coverage exists.

Human Input remains a trusted-loopback UI safety interlock, not authentication against hostile local processes. Gate state is shared among trusted local UI sockets.

## Independent qualification — Drift Windows at `0f2960e6`

Environment: Drift's Windows 11 laptop, exact clean branch HEAD `0f2960e6f8fb38a720503c6444d2ff064000851f`.

Preflight evidence:

- `git pull --ff-only origin eve/nexus-machine-spaces` -> already up to date;
- `git status --short` -> clean;
- `npm run doctor` -> `ok: true`, supervised server healthy, extension connected, Dex UI connected, 7 online targets, 5 local targets, 0 recovery rooms, no state-repair issues;
- control plane at doctor time: 0 provider-control pending, 0 control receipts pending, 0 target operations pending, 0 expired spawn cleanup;
- orchestration recovery active: `null`.

Focused Windows Machine Spaces gate:

- 21 tests / 21 pass / 0 fail;
- includes Human Input enforcement, capability fail-closed behavior, quorum spoof/staleness, same-terminal exclusion, busy-target preflight, lease-safe uncertain cancel, POSIX process-group behavior, Windows tree-kill selection/fallback, and pinned-pipe exit-grace regression.

Native shell live results:

- `cmd.exe` direct -> `NEXUS_CMD_OK`;
- Windows `powershell.exe` direct -> `NEXUS_WINDOWS_POWERSHELL_OK`;
- `wsl.exe --exec bash ...` direct -> `NEXUS_WSL_OK`;
- `pwsh.exe` -> unavailable/not installed on PATH.

EveOS broker live results:

- CMD -> `completed`, exit 0, expected output;
- Windows PowerShell -> `completed`, exit 0, expected output;
- WSL -> `completed`, exit 0, expected output;
- pwsh -> `MACHINE_SHELL_UNAVAILABLE`, matching the machine's installed tools.

Real Windows supervised process-tree proof:

- parent: managed Windows PowerShell supervised job;
- child PID observed live;
- broker `interrupt()` accepted;
- result -> `state: outcome-unknown`, `reason: interrupted`;
- descendant check -> `childAlive: false`;
- broker target -> `busy: false`.

This closes the older live Windows `taskkill /T /F` descendant-termination acceptance item.

Extension reload command at `0f2960e6`:

- `npm run extension:reload` -> `EVEOS_EXTENSION_ASSEMBLY_OK modules=3 assets=106`;
- Nexus reported `reload_extension` successful and extension reconnected.

That older run proved reload/reconnect itself. It did **not** prove the final no-refresh committed ChatGPT result acceptance item.

Historical uncertain turn `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c` was not intentionally replayed. A later doctor showing no active recovery rooms does not retroactively establish the historical send outcome.

## `MS-01` through `MS-04` — Filesystem capability plane

Key source:

- `machine-spaces/capability-grant.js`
- `machine-spaces/filesystem-broker.js`
- `machine-spaces/filesystem-provider-control.js`
- `machine-spaces/server-controller-filesystem.js`
- `extension/content/machine-file-actions.js`

Protected behavior:

- canonical repository-root scoping;
- exact target scoping;
- bounded read/search;
- path/symlink escape rejection;
- SHA-256 mutation preconditions;
- atomic write/replace;
- operation-specific capabilities;
- allow-once consumption;
- persistent expiry and owner revocation;
- provider controls consume only authority already granted by the local owner.

## `MS-05` — Agent quorum and availability

Implemented source:

- `machine-spaces/agent-quorum.js`
- `machine-spaces/agent-quorum-provider-control.js`
- `machine-spaces/server-controller-quorum.js`
- `extension/content/machine-quorum-actions.js`

Provider actions:

- `quorum_presence`
- `quorum_open`
- `quorum_vote`
- `quorum_status`
- `quorum_close`

Rules:

- Eve must originate from ChatGPT, Nova from Codex, Vera from Hark;
- mutating quorum actions require exact committed Dex room/member/message provenance;
- availability evidence expires;
- duplicate control IDs are idempotent only for the exact same vote;
- conflicting reuse rejected;
- one agent cannot cast a second independent vote in one workflow;
- required-agent and majority rules deterministic;
- human-pasted provider text is not presence and cannot vote.

Live proof remains genuine provider-origin voting; the provider qualifier now automates the orchestration while keeping provider provenance real.

## `MS-06` — Supervised servers, rebound and trusted external attachment

Provider controls intentionally stop at:

- `job_prepare`
- `job_status`
- `job_list`

Only the local owner may Start/Reattach/Interrupt.
Reconnect is never authority to replay a command; rebound requires proof that the original managed request remains alive on the exact target/process epoch.
Target loss terminalizes active work as `outcome-unknown`.

Trusted external attachment remains observe/interrupt-only. External command execution is deliberately excluded.

## `MS-07` — Machine Spaces UX

Source implementation now includes:

- collapsible/fallback legacy request history;
- primary unified request cards for terminal/filesystem/supervised work;
- kind/state/actor/query/live filters;
- exact provenance rendering;
- stable cursor paging and Load More;
- local grant/resource controls;
- bounded output paging;
- supervised-job panel with queued/running/deferred/terminal states;
- Human-gated Start/Reattach/Interrupt;
- no-replay rebound behavior;
- local terminal Allow Once/Deny preserved in the primary request view.

Older supervised panel/bounded paging/Human Input behavior was qualified by Vera at `667fb61`.
The new primary unified request companion and controller are post-qualification source and must be rerun in the current terminal bundle before being marked locally/live qualified.

## `MS-08` — Destructive/exact-once security matrix

Source coverage includes:

- filesystem root/target/capability mismatch;
- grant expiry/revocation and allow-once use;
- agent/provider identity spoof rejection;
- stale quorum availability;
- exact control/request dedupe and conflicting reuse;
- provider inability to remotely launch/rebound supervised jobs;
- stale target/process epoch rejection;
- same-terminal race prevention;
- explicit argv contracts for CMD, Windows PowerShell, pwsh and WSL;
- trusted adapter registration/attestation/revocation and no external execute authority;
- external PID epoch-reuse rejection;
- supervised UI authority/output paging;
- unified request-view authority/filter/cursor coverage;
- POSIX and Windows process-tree termination paths.

Historical qualification:

- Vera Linux ARM64: real pwsh 7.6.6 contract `17/17`, supervised lifecycle, busy-target preservation, monotonic lease rebound, Human Input gate, POSIX descendant termination, contiguous large-output paging;
- Drift Windows: real CMD, Windows PowerShell and WSL through EveOS broker; real Windows supervised descendant tree termination; focused Windows matrix 21/21.

Current-source qualification still required. Windows pwsh is not a blocker unless explicitly desired because it is not installed, while real pwsh is already qualified on Vera's host.

## `MS-P0` durable evidence

### `MS-P0-01` — Manual-commit timer binding

Landed: `1219df628`, `fe3561466`.
Invariant: an unconfirmed send is never automatically replayed.

### `MS-P0-02` — Exact tool-result submission confirmation

Landed: `85fbaf598`.
Exact `provider-control-*` request ID is a secondary confirmation anchor; stale/different IDs cannot confirm submission.

### `MS-P0-03` — Explicit stop cleanup

Landed and live-qualified: `52e8e72db`, `96f566d27`.
Room `room-9b5c892d-4daf-4568-a669-6126d9e27305` reached `deferredSends: 0`, no recovery, no active relay and was deleted.

### `MS-P0-04` — Provider-tab rehydration after extension reload

Source implemented with worker-generation handshake: `c1c415d3d`, `0e05087ed`, `d01c3d556`, `61ea2f78a`.

Acceptance remains:

1. use an already-open authenticated ChatGPT target;
2. reload/assemble the EveOS extension;
3. do **not** refresh the ChatGPT page merely to restore the bridge;
4. send one harmless qualification turn;
5. receive the committed result from that same target with exact-once recovery evidence.

`qualify:machine-spaces:chatgpt` automates this lane and blocks itself when recovery/provider-control state makes the run unsafe.

Historical exact-tab reload request: `provider-control-767a3f28-825c-432e-9276-05e654de7155`.

### `MS-P0-05` — Hark human-command attribution

Landed regression: `02cf8014c702462f72928c5a0116db60042a25b0`.
Human-pasted Hark command text rejected; genuine Vera assistant trailing commands remain eligible.

### `MS-P0-06` — Control-origin finalization

Source regressions cover:

- exact early command waiting for finalization;
- exact matching finalized command acceptance;
- stale/wrong turn rejection;
- ambiguous origin rejection;
- bounded timeout;
- duplicate control/mutation dedupe.

Fail-closed codes include:

- `DEX_CONTROL_ORIGIN_TIMEOUT`
- `DEX_CONTROL_ORIGIN_UNCORRELATED`
- `DEX_CONTROL_ORIGIN_AMIGUOUS` is **not** valid; the actual code is `DEX_CONTROL_ORIGIN_AMBIGUOUS`.

Real provider-origin proof remains part of `qualify:machine-spaces:providers`.

### `MS-P0-07` — Managed ChatGPT worker spawn

Source and deterministic cleanup/dedupe paths exist.

Original historical setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`.
Bootstrap conversation: `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`.

Acceptance:

- exactly one fresh managed ChatGPT tab;
- exactly one intended room member;
- duplicate same-control delivery creates no second worker;
- failed/late spawn closes temporary target and leaves no member.

The provider qualifier now performs this using a disposable room and a fresh qualification ChatGPT worker. Never infer a missing historical member makes an uncertain old spawn safe to replay.

### `MS-P0-08` — Stale setup handoff cleanup

Qualified previously. Control ID `provider-control-nova-phase0-stop-room-be-001` succeeded; follow-up reported `deferredSends: 0`. Commit `12dfec316` prevents immediate stop receipt from presenting stale queue state as authoritative.

### `MS-P0-09` — Historical exact-once recovery — DO NOT REPLAY

- exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`
- historical state: `PROMPT_SEND_FAILED`
- recovery classification: `gesture-outcome-unknown`, capture-only

Do **not** resend it, infer the original outcome, or intentionally reproduce it merely to clear the ledger.
Do not refresh that historical provider tab or reload the extension merely to clear this ledger entry.
If the original draft is visibly still present, Drift may commit that exact visible draft once; otherwise recovery remains capture-only.

## Validation history

| Gate | Evidence |
|---|---|
| Phase-0 focused matrix | prior `68/68` at `d01c3d556` |
| Rehydration/control lane | prior `45/45` with `61ea2f78a` |
| Stop/control lane | prior `24/24` with `12dfec316` |
| Full Nexus suite latest Vera rerun | `667fb61`: 1608 total, 1590 pass, 18 fail; same 18 as `main`, zero new failures |
| Real supervised flow | PASS Vera Linux ARM64 / pwsh 7.6.6 / headless Chromium at `667fb61` |
| Human Input server gate | PASS at `667fb61` |
| Busy-target preflight | PASS at `667fb61` |
| POSIX process-tree kill | PASS at `667fb61` |
| Real pwsh shell contract | `17/17` PASS at `667fb61` |
| Drift Windows focused MS matrix | `21/21` PASS at `0f2960e6` |
| Drift Windows CMD broker | PASS / exit 0 at `0f2960e6` |
| Drift Windows PowerShell broker | PASS / exit 0 at `0f2960e6` |
| Drift Windows WSL broker | PASS / exit 0 at `0f2960e6` |
| Drift Windows supervised descendant tree-kill | PASS; child dead, outcome-unknown/interrupted, terminal free at `0f2960e6` |
| Drift Windows pwsh | unavailable on PATH; not a failure of broker semantics |
| Drift extension assembly/reload/reconnect | PASS; 3 modules / 106 assets at `0f2960e6` |
| Current post-qualification source | **not yet rerun**; terminal bundle now includes deterministic request-view, external adapter and provider provenance lanes |
| Unconfirmed-interrupt lease edge | unit-covered only; not naturally forced live |

## Quota-stop protocol

1. Finish or explicitly abort current mutation.
2. Never retry uncertain send/spawn/terminal/file/supervised/provider mutation.
3. Record exact Git HEAD, worktree state and relevant room/turn/request/control/grant/job/target/process-epoch IDs.
4. Commit/push only coherent work.
5. Update this ledger with the next single action.
6. Keep process/tab/draft/credential/runtime facts only in ignored local checkpoint state.
7. On resume, verify Git and live Nexus state before trusting either record.
8. Do not create replacement rooms merely because an existing room is stuck.

## Known unrelated gate debt

Root structural guardrails previously stopped on pre-existing AudioFlix line-growth debt. Do not refactor these as Machine Spaces work:

- `js/modules/features/audioflix/audioflix.audio.url.spotify.js`
- `server_modules/audioflix_spotify_scrape.js`
- `js/modules/features/audioflix/audioflix.audio.js`
- `js/modules/features/audioflix/audioflix.audio.url.js`
