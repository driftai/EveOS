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
| Last independently qualified source HEAD | `667fb612a66aecd9c45ffa85707e22872a570720` (Vera, Linux ARM64 / pwsh 7.6.6 / headless Chromium) |
| Qualification range | `cd457db9069a0375570c99f260fb1ce1ada92f59` -> `667fb612a66aecd9c45ffa85707e22872a570720` locally qualified on Linux |
| Main unresolved live blocker | `MS-P0` exact-origin / managed-worker live qualification |
| Current safe next action | Run Windows-specific shell/process-tree gates on Drift's laptop, continue P0 live proofs without disturbing the unresolved exact-once recovery, and build/qualify the real external-terminal adapter transport beyond the existing trust plane |

## Roadmap state

| ID | Status | Source state / remaining proof |
|---|---|---|
| `MS-P0` | active-live-qualification | cleanup/rehydration/correlation fixes exist; exact origin, no-refresh reload, managed-worker proof and one unresolved recovery remain |
| `MS-01` | source-implemented | canonical repo roots + local Allow Once/Persistent/Deny filesystem grants exist |
| `MS-02` | source-implemented | tree/stat/bounded read/search primitives exist |
| `MS-03` | source-implemented | hash-guarded create/write/patch/move/delete + atomic writes exist |
| `MS-04` | source-implemented | capability grants, expiry, revocation and once-use consumption exist |
| `MS-05` | source-implemented / live-quorum pending | Eve/Nova/Vera identity, presence, voting, quorum and provider controls wired; real-origin quorum still pending |
| `MS-06` | Linux/pwsh supervised flow qualified at `667fb61`; Windows + external adapter pending | start/defer/rebound/interrupt/paging, busy-target preflight, monotonic leases, server Human Input gate and POSIX tree-kill passed Vera's live rerun; unconfirmed-interrupt lease edge is unit-only; real external adapter transport and Windows tree behavior remain |
| `MS-07` | supervised UX + server Human Input gate locally qualified at `667fb61` | headed Chromium flow and bounded paging passed; generic filter view model is source-ready but not yet the primary visible request list |
| `MS-08` | partial local qualification at `667fb61` | real pwsh 7.6.6 contract 17/17 and Linux/POSIX safety lanes pass; Windows CMD/Windows PowerShell/WSL, Windows tree-kill and exit-grace remain |

## Independent qualification evidence — Vera at `cd457db`

Environment: Linux ARM64, real PowerShell 7.6.6, headless Chromium UI clicks.

PASS:

- `job_prepare` -> `queued`;
- same request ID with a different command -> `MACHINE_JOB_REQUEST_CONFLICT`;
- local Start -> `running`;
- supervisor disconnect -> `deferred`, same PID, no relaunch;
- Start on a deferred job refused;
- reattach -> same process epoch and same PID;
- second reattach refused;
- interrupt -> `outcome-unknown`;
- paging over 3000 output lines, `Load More` appends in order;
- browser Human Input lock disables supervised mutation controls;
- real `pwsh` contract: `17/17` pass;
- `npm test`: same 18 pre-existing failures as `main`, no new Machine Spaces failures.

Qualification caveat: the `job_prepare` test used a synthetic Dex origin because a genuine origin requires a live relay turn.

Vera found and fixed one real runtime bug in `cd457db`: on POSIX, interrupting only the shell could orphan descendants that held stdout/stderr pipes open and left the terminal busy. Supervised POSIX processes now get their own process group and interrupt/timeout terminates that group. Shutdown must continue to call `stopAll` because detached POSIX children no longer inherit console Ctrl+C.

## Independent qualification evidence — Vera at `667fb61`

Environment: Linux ARM64, real PowerShell 7.6.6, headless Chromium UI.

PASS:

- `npm test`: 1608 tests, 1590 pass, 18 fail; the same 18 baseline failures as `main`, with nothing new;
- supervised UI flow: Start issued lease generation 1;
- disconnect -> `deferred`, same PID, no relaunch;
- reattach -> same PID and process epoch, lease generation 2;
- second reattach refused;
- interrupt -> `outcome-unknown` with no leftover processes;
- output paging over 3000 lines is contiguous;
- browser console remained clean;
- raw local UI socket with Human Input locked gets `MACHINE_HUMAN_INPUT_LOCKED` on Start, Cancel and Reattach;
- busy-target Start returns `MACHINE_TARGET_BUSY`, leaves the job `queued`, then runs and completes exit 0 after the terminal becomes free;
- POSIX tree-kill works for `sleep`, `Start-Sleep` and `/bin/sleep`, all interrupting to `outcome-unknown` with no orphaned descendants;
- real `pwsh` shell contract: `17/17` pass.

Not exercised live at `667fb61`:

- the deliberately unconfirmed-interrupt lease path could not be forced naturally; its protection remains unit-test-covered rather than live-qualified;
- Windows `taskkill /T /F` process-tree termination;
- Windows inherited-pipe exit-grace behavior;
- Windows CMD, Windows PowerShell and WSL shell contracts.

Human Input design note: the gate state is shared across trusted local UI sockets. If any trusted local Nexus UI socket enables Human Input, the local UI gate is open for the other trusted local UI sockets, and a local UI socket can send `machine_set_human_input`. This is intentional only under the current trusted-loopback-UI model. It is a safety interlock, not protection against hostile local processes.

`dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c` was not touched by this qualification.

## Post-`cd457db` hardening — Linux-qualified at `667fb61`; Windows-specific proof pending

The following source changes were added after Vera's original `cd457db` checkpoint. Vera's rerun at `667fb61` qualified the Linux/pwsh and headed-browser behavior described below except where explicitly marked unit-only or Windows-pending.

### Busy target preflight

`server-controller-supervised.js` checks broker activity before changing a queued job to running.

Protected and live-qualified at `667fb61`:

- a busy terminal returns `MACHINE_TARGET_BUSY`;
- the job remains `queued`;
- the prepared command remains in the command store;
- no supervised process is spawned;
- after the target becomes free the same queued job can Start and complete normally.

### Lease-safe cancel / uncertain interrupt settlement

A running job carries its current supervision lease into local cancel/settlement paths.
If interrupt cannot be confirmed, settlement becomes `outcome-unknown` with
`MACHINE_JOB_INTERRUPT_UNCONFIRMED` instead of throwing `MACHINE_JOB_LEASE_INVALID` and leaving the job stuck running.

The ordinary live interrupt path passed at `667fb61` and left no descendants. The specifically unconfirmed-interrupt branch could not be forced naturally and remains unit-test-covered only.

### Monotonic rebound lease generation

`supervised-job.js` stores an independent `leaseGeneration` counter.
Start uses generation 1; defer preserves that generation; rebound issues generation 2, then 3, etc.
The transient lease may be cleared, but its generation never resets during the same job lifecycle.

Live-qualified at `667fb61`: Start generation 1 -> defer -> rebound generation 2 with the same PID and process epoch and no command replay.

### Windows process-tree termination and pipe-close grace

`managed-terminal-broker.js` has a Windows supervised termination path using
`taskkill.exe /pid <pid> /t /f`, with direct `child.kill()` as fallback.
Bounded and supervised runs also settle from process `exit` after a short grace period rather than waiting indefinitely for `close` while inherited child pipes remain open.

Source regressions cover:

- Windows tree-kill selection;
- direct-child fallback;
- pinned-pipe `exit` grace release;
- POSIX process-group termination;
- same-terminal busy exclusion.

POSIX process-group termination was re-qualified live at `667fb61`.

**Windows behavior is not live-qualified yet.** Drift must run the Windows shell/process-tree gates on the real laptop.

### Server-side Human Input safety interlock

An outer Machine Spaces controller layer mirrors the Dex Human Input toggle to the server.
It defaults locked and gates local Dex resource/process mutations including:

- create/archive space;
- attach/detach terminal;
- repo/file grant enable/revoke;
- supervised Start/Reattach/Interrupt;
- trusted-adapter / trusted-attachment mutations;
- Dex-origin command approval;
- Dex-scoped terminal creation/stop/interrupt.

Base Mode terminal creation/use remains independent.
The enabling UI socket is tracked; when it disconnects, its enable lease disappears and the gate relocks when no enabling UI remains.
Provider-control does not gain authority from this toggle and remains governed by its own provenance/capability rules.

`public/machine-human-gate-ui.js` mirrors the browser `data-human-input` state to this server gate.
Dex `Create terminal` is intercepted in capture phase and resent with the active `roomId`, preventing it from being misclassified as a Base Mode terminal mutation.

Live-qualified at `667fb61`: a raw local UI socket is rejected with `MACHINE_HUMAN_INPUT_LOCKED` for supervised Start, Cancel and Reattach while the gate is locked.

Security note: this is a **loopback safety interlock, not an authentication boundary**. Nexus UI WebSockets are not cryptographically authenticated, so hostile local software that can impersonate an allowed loopback UI is outside this gate's trust claim. Gate state is shared among trusted local UI sockets.

### Post-qualification commits

- `791fb1ff` — monotonic supervised lease generation
- `aee42b08` — busy preflight + lease-safe cancel
- `9fb742bf` — Windows tree-kill + exit grace
- `e5dbab07` — lease-generation regressions
- `60e775a9` — Windows/POSIX process-tree regressions
- `8b8b39ec` — server-side Human Input interlock
- `4105b723` — human gate layered around Machine Spaces controller
- `8f11da59` — browser Human Input gate companion
- `61c9805a` — companion injection
- `db0d7ad4` — human-gate server regressions
- `78ad4265` — supervised busy/cancel safety regressions
- `22508321` — companion/UI regression coverage
- `5ea0235c` — runtime test explicitly unlocks Dex mutations
- `1d9ca0f7` — repo-safe test explicitly unlocks Dex mutations
- `ea04fff7` — Dex terminal creation gets exact room provenance
- `457e28a5` — regression for gated Dex terminal creation

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
- conflicting reuse is rejected;
- one agent cannot cast a second independent vote in one workflow;
- required-agent and majority rules are deterministic;
- human-pasted provider text is not presence and cannot vote.

Remaining live proof: use genuine relay origins with Eve/ChatGPT and Vera/Hark (and Nova/Codex when available). Vera can provide the Hark side.

## `MS-06` — Supervised servers, rebound and trusted attachment

Provider controls intentionally stop at:

- `job_prepare`
- `job_status`
- `job_list`

Only local UI may Start/Reattach/Interrupt.
Reconnect is never authority to replay a command; rebound requires proof that the original managed request is still alive on the exact target/process epoch.
Target loss terminalizes active work as `outcome-unknown`.

Trusted external attachment source exists in:

- `machine-spaces/trusted-terminal-attachment.js`
- `machine-spaces/server-controller-trusted-attach.js`

The trust plane uses a local adapter credential plus one-time HMAC challenge bound to target ID, process epoch, adapter ID, cwd and shell type. Trusted external capabilities remain `observe` and `interrupt` only; `execute` is deliberately excluded.

Remaining source/integration gap: a real external terminal adapter still has to transport the challenge/proof and implement observe/interrupt against a pre-existing terminal. The trust plane alone is not a claim that arbitrary Windows Terminal processes are already controllable.

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

Vera qualified the supervised panel, bounded paging and server Human Input gate at `667fb61` with headless Chromium. The generic request-view filter model remains source-ready but is not yet the primary visible request list.

## `MS-08` — Destructive/exact-once security matrix

Source tests cover:

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

Qualified at `667fb61`: real pwsh 7.6.6 contract `17/17` on Vera's Linux ARM64 machine; supervised lifecycle; busy-target preservation; monotonic lease rebound; Human Input server gate; POSIX descendant termination with no orphans; contiguous large-output paging.

Unit-only caveat: the specifically unconfirmed-interrupt lease settlement branch is regression-covered but was not naturally forced live.

Still required on Drift's Windows laptop: CMD, Windows PowerShell, pwsh if desired, WSL, Windows `taskkill /T /F`, and Windows inherited-pipe exit-grace behavior.

## `MS-P0` durable evidence

### `MS-P0-01` — Manual-commit timer binding

Landed. Commits: `1219df628`, `fe3561466`.
Protected invariant: an unconfirmed send is never automatically replayed.

### `MS-P0-02` — Exact tool-result submission confirmation

Landed. Commit: `85fbaf598`.
Exact `provider-control-*` request ID is a secondary confirmation anchor; stale/different request IDs cannot confirm a submission.

### `MS-P0-03` — Explicit stop cleanup

Landed and live-qualified. Commits: `52e8e72db`, `96f566d27`.
Room `room-9b5c892d-4daf-4568-a669-6126d9e27305` reached `deferredSends: 0`, no recovery, no active relay and was deleted.

### `MS-P0-04` — Provider-tab rehydration after extension reload

Source implemented with worker-generation handshake. Commits: `c1c415d3d`, `0e05087ed`, `d01c3d556`, `61ea2f78a`.

Live acceptance still required on Drift's logged-in ChatGPT tab:

1. reload EveOS Bridge / Nexus extension;
2. **do not refresh ChatGPT**;
3. send a harmless Dex status command;
4. receive the committed result from the already-open tab.

Historical control request after an exact-tab reload: `provider-control-767a3f28-825c-432e-9276-05e654de7155`.

### `MS-P0-05` — Hark human-command attribution

Landed regression: `02cf8014c702462f72928c5a0116db60042a25b0`.
Human-pasted Hark command text is rejected while genuine Vera assistant trailing commands remain eligible.

### `MS-P0-06` — Control-origin finalization

Still requires live proof on Drift's provider tabs.
Fail-closed codes include:

- `DEX_CONTROL_ORIGIN_TIMEOUT`
- `DEX_CONTROL_ORIGIN_UNCORRELATED`
- `DEX_CONTROL_ORIGIN_AMBIGUOUS`

Acceptance:

- exact early command waits for finalization and executes once;
- exact matching late command is accepted;
- stale/wrong turn is rejected;
- duplicate same control ID cannot execute twice.

### `MS-P0-07` — Managed ChatGPT worker spawn

Live proof pending.

Original setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`.
Bootstrap conversation: `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`.

Acceptance: exactly one fresh managed ChatGPT tab, exactly one intended room member, duplicate same-control delivery creates no second worker, and failed spawn closes its temporary target with no member left behind.
Never infer that a missing member makes an uncertain historical spawn safe to replay.

### `MS-P0-08` — Stale setup handoff cleanup

Qualified previously. Control ID `provider-control-nova-phase0-stop-room-be-001` succeeded; follow-up reported `deferredSends: 0`. Commit `12dfec316` prevents the immediate stop receipt from presenting stale queue state as authoritative.

### `MS-P0-09` — Unresolved exact-once recovery — DO NOT REPLAY

- exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`
- state: `PROMPT_SEND_FAILED`
- recovery: `gesture-outcome-unknown`, capture-only

Do **not** resend it, refresh that provider tab, reload the extension merely to clear it, or infer the draft was unsent.
If the original draft is visibly present, Drift may commit that same draft once with Enter; otherwise allow the bounded recovery lifecycle to settle.
This record must not be hidden by later source progress.

## Validation history

| Gate | Evidence |
|---|---|
| Phase-0 focused matrix | prior `68/68` at `d01c3d556` |
| Rehydration/control lane | prior `45/45` with `61ea2f78a` |
| Stop/control lane | prior `24/24` with `12dfec316` |
| Full Nexus suite at latest Vera rerun | `667fb61`: 1608 total, 1590 pass, 18 fail; same 18 failures as `main`, zero new failures |
| Real supervised flow | PASS on Vera Linux ARM64 / pwsh 7.6.6 / headless Chromium at `667fb61` |
| Human Input server gate | PASS at `667fb61`; raw local UI socket rejected with `MACHINE_HUMAN_INPUT_LOCKED` on Start/Cancel/Reattach while locked |
| Busy-target preflight | PASS at `667fb61`; job stayed queued, then ran after target freed |
| POSIX process-tree kill | PASS at `667fb61`; `sleep`, `Start-Sleep`, `/bin/sleep` interrupted with no orphans |
| Real pwsh shell contract | `17/17` PASS at `667fb61` |
| Unconfirmed-interrupt lease edge | unit-test-covered only; not forced naturally in Vera live rerun |
| Windows process-tree / exit-grace / native shells | pending Drift laptop qualification |

## Quota-stop protocol

1. Finish or explicitly abort the current mutation.
2. Never retry an uncertain send/spawn/terminal/file/supervised mutation.
3. Record exact Git HEAD, worktree state and relevant room/turn/request/control/grant/job/target/process-epoch IDs.
4. Commit and push only coherent work.
5. Update this ledger with the next single action.
6. Keep process/tab/draft/credential/runtime facts only in ignored local checkpoint state.
7. On resume, verify Git and live Nexus state before trusting either record.
8. Do not create replacement rooms merely because an existing room is stuck.

## Known unrelated gate debt

Root structural guardrails previously stopped on pre-existing AudioFlix line-growth debt. Do not refactor these as part of Machine Spaces:

- `js/modules/features/audioflix/audioflix.audio.url.spotify.js`
- `server_modules/audioflix_spotify_scrape.js`
- `js/modules/features/audioflix/audioflix.audio.js`
- `js/modules/features/audioflix/audioflix.audio.url.js`
