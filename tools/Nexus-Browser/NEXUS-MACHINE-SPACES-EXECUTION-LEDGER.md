# Nexus Machine Spaces execution ledger

Durable source-of-truth for Machine Spaces and the Dex control path that drives it.
Keep PIDs, tab IDs, drafts, live recovery timers, adapter secrets, and other transient
machine state only in the ignored runtime checkpoint:

`data/runtime/nexus-browser/machine-spaces-checkpoint.json`

## Operating invariants

- Active development branch: `eve/nexus-machine-spaces`. Do not merge or move `main` unless Drift explicitly requests it.
- Never replay an uncertain send, spawn, terminal command, file mutation, or supervised job.
- Provider and agent identities are distinct: ChatGPT/Eve, Codex/Nova, Hark/Vera.
- Exact room/member/message/request/control/target/process-epoch/grant/job provenance wins over inferred transcript state.
- Human/local approval gates are not substitutable by provider text.
- Source implementation, automated regression coverage, local qualification, and live qualification are separate states.
- Commit only coherent source work. Runtime state and credentials stay untracked.

## Current checkpoint

| Field | Value |
|---|---|
| Branch | `eve/nexus-machine-spaces` |
| Current branch HEAD at latest Windows qualification | `0f2960e6f8fb38a720503c6444d2ff064000851f` |
| Last independently qualified Machine Spaces source HEAD | `667fb612a66aecd9c45ffa85707e22872a570720` (Vera, Linux ARM64 / pwsh 7.6.6 / headless Chromium) |
| Windows qualification | PASS on Drift laptop at `0f2960e6`; Machine Spaces source is unchanged from `667fb61` apart from later docs and unrelated AudioFlix integration |
| Main unresolved live blocker | `MS-P0` provider-tab exact-origin / no-refresh rehydration / managed-worker live qualification |
| Current safe next action | Run the real Windows inherited-pipe exit-grace probe, then continue P0 provider-tab live proofs without replaying historical uncertain work; external-terminal adapter transport remains the next source implementation gap |

## Roadmap state

| ID | Status | Source state / remaining proof |
|---|---|---|
| `MS-P0` | active-live-qualification | cleanup/rehydration/correlation fixes exist; extension reload command now passes on Drift Windows, but no-refresh provider response, exact-origin lifecycle and managed-worker proof remain |
| `MS-01` | source-implemented | canonical repo roots + local Allow Once/Persistent/Deny filesystem grants exist |
| `MS-02` | source-implemented | tree/stat/bounded read/search primitives exist |
| `MS-03` | source-implemented | hash-guarded create/write/patch/move/delete + atomic writes exist |
| `MS-04` | source-implemented | capability grants, expiry, revocation and once-use consumption exist |
| `MS-05` | source-implemented / live-quorum pending | Eve/Nova/Vera identity, presence, voting, quorum and provider controls wired; genuine relay-origin quorum remains |
| `MS-06` | supervised flow qualified on Linux and Windows tree-kill qualified | start/defer/rebound/interrupt/paging, busy-target preflight, monotonic leases, Human Input gate and POSIX tree-kill passed Vera; Windows supervised descendant tree-kill passed Drift; unconfirmed-interrupt branch is unit-only; real external adapter transport remains |
| `MS-07` | supervised UX + server Human Input gate locally qualified | headed Chromium flow and bounded paging passed; generic filter view model is source-ready but not yet the primary visible request list |
| `MS-08` | mostly qualified; one Windows live edge remains | Linux pwsh 17/17; Windows CMD, Windows PowerShell, WSL and real taskkill tree termination pass; Windows pwsh is not installed on Drift PATH; real inherited-pipe exit-grace is still pending |

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

This closes the live Windows `taskkill /T /F` descendant-termination acceptance item.

Still pending on Windows:

- real inherited-pipe exit-grace proof where the shell exits but a descendant temporarily retains inherited stdout/stderr; unit regression is green, but a real live pin has not yet been recorded;
- Windows pwsh is optional and currently unavailable on PATH; Linux real pwsh is already qualified by Vera.

Extension reload command at `0f2960e6`:

- `npm run extension:reload` -> `EVEOS_EXTENSION_ASSEMBLY_OK modules=3 assets=106`;
- Nexus reports `reload_extension` successful and extension reconnected.

This proves reload/reconnect itself on Drift's machine. It does **not** yet prove `MS-P0-04` no-refresh rehydration because the remaining acceptance step is a committed harmless Dex control result from an already-open logged-in ChatGPT tab without refreshing that page.

Historical uncertain turn `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c` was not intentionally replayed. Current doctor reported no active recovery rooms and no pending provider controls, but that does not retroactively establish the historical send outcome.

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

Remaining live proof: genuine relay origins with Eve/ChatGPT and Vera/Hark (Nova/Codex when available).

## `MS-06` — Supervised servers, rebound and trusted external attachment

Provider controls intentionally stop at:

- `job_prepare`
- `job_status`
- `job_list`

Only local UI may Start/Reattach/Interrupt.
Reconnect is never authority to replay a command; rebound requires proof that the original managed request remains alive on the exact target/process epoch.
Target loss terminalizes active work as `outcome-unknown`.

Trusted external attachment source:

- `machine-spaces/trusted-terminal-attachment.js`
- `machine-spaces/server-controller-trusted-attach.js`

Trust plane:

- local adapter credential;
- one-time HMAC challenge bound to target ID, process epoch, adapter ID, cwd, shell type;
- capabilities remain `observe` and `interrupt` only;
- external `execute` deliberately excluded.

Remaining source/integration gap: real external-terminal adapter transport. It must carry challenge/proof and implement observe/interrupt against a pre-existing external terminal. The trust plane alone is not a claim that arbitrary Windows Terminal processes are already controllable.

## `MS-07` — Machine Spaces UX

Implemented:

- collapsible request history;
- terminal/filesystem request cards;
- local grant/resource controls;
- bounded output paging;
- supervised-job panel with queued/running/deferred/terminal states;
- Human-gated Start/Reattach/Interrupt;
- no-replay rebound copy;
- output `Load More`;
- unified `request-view.js` projection with kind/state/actor/query filters, exact provenance and cursor paging.

Vera qualified supervised panel, bounded paging and server Human Input gate at `667fb61`. Generic request-view filtering remains source-ready but is not yet the primary visible list.

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
- supervised UI authority/output paging;
- POSIX and Windows process-tree termination paths.

Qualified:

- Vera Linux ARM64: real pwsh 7.6.6 contract `17/17`, supervised lifecycle, busy-target preservation, monotonic lease rebound, Human Input gate, POSIX descendant termination, contiguous large-output paging;
- Drift Windows: real CMD, Windows PowerShell and WSL through EveOS broker; real Windows supervised descendant tree termination; focused Windows matrix 21/21.

Remaining:

- real Windows inherited-pipe exit-grace acceptance;
- unconfirmed-interrupt lease edge remains unit-only because it was not naturally forced;
- Windows pwsh is not a blocker unless explicitly desired because it is not installed, while real pwsh is already qualified on Vera's host.

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

Drift Windows reload/reconnect command now passes at `0f2960e6`.

Live acceptance still required:

1. keep an already-open logged-in ChatGPT tab bound;
2. reload EveOS Bridge / Nexus extension;
3. **do not refresh ChatGPT**;
4. send one harmless exact Dex status/control;
5. receive the committed result from that same already-open tab.

Historical exact-tab reload request: `provider-control-767a3f28-825c-432e-9276-05e654de7155`.

### `MS-P0-05` — Hark human-command attribution

Landed regression: `02cf8014c702462f72928c5a0116db60042a25b0`.
Human-pasted Hark command text rejected; genuine Vera assistant trailing commands remain eligible.

### `MS-P0-06` — Control-origin finalization

Live provider-tab proof still required.
Fail-closed codes include:

- `DEX_CONTROL_ORIGIN_TIMEOUT`
- `DEX_CONTROL_ORIGIN_UNCORRELATED`
- `DEX_CONTROL_ORIGIN_AMBIGUOUS`

Acceptance:

- exact early command waits for finalization and executes once;
- exact matching late command accepted;
- stale/wrong turn rejected;
- duplicate same control ID cannot execute twice.

### `MS-P0-07` — Managed ChatGPT worker spawn

Live proof pending.

Original setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`.
Bootstrap conversation: `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`.

Acceptance:

- exactly one fresh managed ChatGPT tab;
- exactly one intended room member;
- duplicate same-control delivery creates no second worker;
- failed spawn closes temporary target and leaves no member.

Never infer missing member makes an uncertain historical spawn safe to replay.

### `MS-P0-08` — Stale setup handoff cleanup

Qualified previously. Control ID `provider-control-nova-phase0-stop-room-be-001` succeeded; follow-up reported `deferredSends: 0`. Commit `12dfec316` prevents immediate stop receipt from presenting stale queue state as authoritative.

### `MS-P0-09` — Historical exact-once recovery — DO NOT REPLAY

- exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`
- historical state: `PROMPT_SEND_FAILED`
- recovery classification: `gesture-outcome-unknown`, capture-only

Do **not** resend it, infer the original outcome, or intentionally reproduce it merely to clear the ledger.
Current Drift doctor at `0f2960e6` reports no active recovery rooms and no pending provider controls; this is current runtime health, not retrospective proof of that turn's send outcome.

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
| Windows inherited-pipe exit-grace | unit regression PASS; real live acceptance still pending |
| Unconfirmed-interrupt lease edge | unit-covered only; not naturally forced live |

## Quota-stop protocol

1. Finish or explicitly abort current mutation.
2. Never retry uncertain send/spawn/terminal/file/supervised mutation.
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
