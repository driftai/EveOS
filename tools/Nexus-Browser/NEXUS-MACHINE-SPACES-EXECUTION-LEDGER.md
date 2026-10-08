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
- UI participation may be part of a proof, but UI clicking is not the only supported control surface. Qualification must be terminal-drivable wherever the underlying operation is automatable.
- Commit only coherent source work. Runtime state and credentials stay untracked.

## Current checkpoint

| Field | Value |
|---|---|
| Branch | `eve/nexus-machine-spaces` |
| Post-qualification source HEAD before this ledger update | `b870970b855ba7e18d7af3fd171e5989d4e7e945` |
| Last independently qualified Machine Spaces source HEAD | `667fb612a66aecd9c45ffa85707e22872a570720` — Vera, Linux ARM64 / pwsh 7.6.6 / headless Chromium |
| Last Drift Windows qualification | `0f2960e6f8fb38a720503c6444d2ff064000851f` — then-current Windows-focused gates passed |
| Source roadmap | `MS-P0` through `MS-08` all have implementation paths; no planned stage is intentionally left source-unimplemented |
| Current acceptance state | source complete, **current head not yet independently rerun** |
| Next action | pull current branch, restart Nexus, run `npm test`, then `npm run qualify:machine-spaces:complete`; paste the single bounded report back to Eve |

## Roadmap state

| ID | Status | Source state / remaining proof |
|---|---|---|
| `MS-P0` | source-implemented / live qualification pending | cleanup, exact-origin correlation, rehydration, dedupe, result-query, spawn cleanup and terminal-driven provider qualification exist; no-refresh exact-origin + managed-worker live acceptance still need current bundle run |
| `MS-01` | source-implemented | canonical repository roots + local Allow Once/Persistent/Deny filesystem grants |
| `MS-02` | source-implemented | tree/stat/bounded reads/line counts/search |
| `MS-03` | source-implemented | SHA-guarded create/write/patch/move/delete + atomic replacement |
| `MS-04` | source-implemented | capability-specific persistent/once grants, expiry and revocation |
| `MS-05` | source-implemented / live quorum pending | Eve/Nova/Vera identity, presence and exact-origin voting; terminal provider qualifier drives real Eve/ChatGPT + Vera/Hark when Hark is connected |
| `MS-06` | source-implemented; older supervised flow qualified | supervised start/defer/rebound/interrupt/paging, busy preflight, monotonic leases, process-tree termination, trusted external PID observe/interrupt transport; current external live probe pending |
| `MS-07` | source-implemented / current UI qualification pending | primary unified terminal/filesystem/supervised request list now uses server-side filters/provenance/cursor paging with legacy fallback and CSP-clean external styling |
| `MS-08` | source-implemented / current bundle pending | destructive/exact-once matrix and native-shell probes exist; older Linux/Windows evidence remains historical until current source is rerun |

## Terminal-first qualification

From `tools/Nexus-Browser`:

- `npm test`
  - full Nexus regression suite;
- `npm run qualify:machine-spaces`
  - deterministic P0/origin/dedupe/spawn/quorum/request-view/trusted-attachment tests plus focused Machine Spaces and native-shell probes;
- `npm run qualify:machine-spaces:external`
  - adds real trusted external PID probe/attest/observe/interrupt/revoke through the running Nexus server;
- `npm run qualify:machine-spaces:chatgpt`
  - adds extension assembly/reload plus warm authenticated ChatGPT exact-once/recovery proof without requiring a manual page refresh;
- `npm run qualify:machine-spaces:providers`
  - disposable real-provider provenance room; fresh ChatGPT worker; exact-origin effect + managed spawn; Eve/Vera quorum when a genuine Hark target is connected;
- `npm run qualify:machine-spaces:complete`
  - emits one top-level `MACHINE_SPACES_COMPLETE_QUALIFICATION_BEGIN/END` report combining the all-live gate and, only after that passes, the provider provenance gate.

The complete wrapper does **not** start provider mutations when the lower deterministic/live Machine Spaces gate fails or blocks. It never retries an uncertain provider mutation.

## Post-qualification source additions

### Supervised/job hardening

- supervision lease generation remains monotonic across defer/rebound;
- queued jobs preflight target busy state before transitioning to running;
- cancel/outcome-unknown settlement carries the current supervision lease;
- POSIX supervised children run in process groups;
- Windows termination selects `taskkill /T /F` with direct-child fallback;
- shell `exit` plus bounded pipe-drain grace prevents inherited descendant pipes from holding a target busy forever;
- server-side Human Input gate protects Dex Machine Spaces mutation paths;
- Dex terminal creation is room-scoped through that gate.

### Trusted external terminal transport

Source:

- `machine-spaces/trusted-terminal-attachment.js`
- `machine-spaces/server-controller-trusted-attach.js`
- `machine-spaces/external-terminal-process-adapter.js`
- `scripts/external-terminal-adapter-qualify.js`

Behavior:

- probe a pre-existing PID and pin its exact process start epoch;
- PID reuse/epoch mismatch fails closed;
- observe bounded identity/liveness metadata;
- interrupt the exact process tree;
- trusted capabilities remain `observe` and `interrupt` only;
- **no external execute capability exists**.

The live qualifier launches a harmless temporary process, registers temporary trust, proves exact PID/epoch attestation, observes, interrupts, verifies termination, revokes trust, and disables Human Input.

### Primary unified request view (`MS-07`)

Source:

- `machine-spaces/request-view.js`
- `machine-spaces/server-controller-request-view.js`
- `public/machine-request-view-ui.js`
- `public/machine-spaces.css`

Server API: `machine_request_view`.

Properties:

- local loopback UI/terminal socket only;
- combines terminal, filesystem and exact room/space supervised jobs;
- filters by kind, state, actor, free-text query and live-only;
- stable newest-first cursor pagination;
- exact request/source-message/actor/terminal/process-epoch/grant/capability/digest/output provenance;
- primary visible list activates only after the server successfully answers;
- old request list remains a reconnect/unsupported-server fail-safe;
- approval-required terminal cards retain local Allow Once/Deny controls;
- bounded output paging remains available;
- styling is in external `machine-spaces.css`, not inline `<style>`, so the Nexus CSP remains intact.

The specialized supervised-job panel remains the dedicated Start/Reattach/Interrupt surface even though supervised jobs also appear in the unified audit list.

## Historical independent qualification — Vera at `667fb61`

Environment: Linux ARM64, real PowerShell 7.6.6, headless Chromium.

PASS:

- `npm test`: 1608 total, 1590 pass, 18 fail; same 18 baseline failures as `main`, zero new Machine Spaces failures;
- supervised Start -> running lease generation 1;
- disconnect -> deferred, same PID, no relaunch;
- rebound -> same PID/process epoch, lease generation 2;
- second rebound refused;
- interrupt -> `outcome-unknown`, no leftover descendants;
- >3000-line paging contiguous;
- browser console clean;
- raw local UI socket receives `MACHINE_HUMAN_INPUT_LOCKED` while gate disabled;
- busy-target Start -> `MACHINE_TARGET_BUSY`, queued job preserved;
- POSIX descendant tree kill passed;
- real pwsh shell contract `17/17`.

Unconfirmed-interrupt lease settlement remained unit-only because it was not naturally forced live.

## Historical independent qualification — Drift Windows at `0f2960e6`

Environment: Windows 11 laptop.

PASS evidence at that HEAD:

- focused Windows Machine Spaces gate: `21/21`;
- CMD through broker -> completed / exit 0;
- Windows PowerShell through broker -> completed / exit 0;
- WSL through broker -> completed / exit 0;
- Windows supervised descendant tree-kill -> child dead, `outcome-unknown` / interrupted, terminal free;
- extension assembly/reload/reconnect -> PASS, 3 modules / 106 assets.

`pwsh.exe` was not installed on PATH. Linux real pwsh was already qualified by Vera.

That older extension run proved reload/reconnect, not the final no-refresh committed ChatGPT result acceptance item.

## Filesystem capability plane (`MS-01`–`MS-04`)

Protected behavior:

- canonical repository-root scoping;
- exact target scoping;
- bounded read/search;
- path and symlink escape rejection;
- SHA-256 preconditions on existing-file mutation;
- atomic write/replace;
- operation-specific capabilities;
- allow-once consumption;
- persistent expiry/revocation;
- provider controls can consume only authority already granted by the local owner.

## Agent quorum (`MS-05`)

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
- one agent gets one independent vote per workflow;
- required-agent and majority rules deterministic;
- human-pasted provider text cannot create presence or cast a vote.

## `MS-P0` durable evidence

### `MS-P0-01` — Manual-commit timer binding

Landed: `1219df628`, `fe3561466`.
Invariant: an unconfirmed send is never automatically replayed.

### `MS-P0-02` — Exact tool-result confirmation

Landed: `85fbaf598`.
Exact `provider-control-*` request ID is a secondary confirmation anchor; stale/different IDs cannot confirm submission.

### `MS-P0-03` — Explicit stop cleanup

Landed/live-qualified: `52e8e72db`, `96f566d27`.
Room `room-9b5c892d-4daf-4568-a669-6126d9e27305` reached `deferredSends: 0`, no recovery, no active relay, then deleted.

### `MS-P0-04` — Provider-tab rehydration

Worker-generation handshake source: `c1c415d3d`, `0e05087ed`, `d01c3d556`, `61ea2f78a`.

Acceptance:

1. already-open authenticated ChatGPT target;
2. assemble/reload extension;
3. **do not refresh ChatGPT merely to restore the bridge**;
4. send one harmless qualification turn;
5. receive the committed result with exact-once recovery evidence.

Historical exact-tab reload request: `provider-control-767a3f28-825c-432e-9276-05e654de7155`.

### `MS-P0-05` — Hark human-command attribution

Landed regression: `02cf8014c702462f72928c5a0116db60042a25b0`.
Human-pasted Hark command text is rejected; genuine Vera assistant trailing commands remain eligible.

### `MS-P0-06` — Control-origin finalization

Fail-closed codes:

- `DEX_CONTROL_ORIGIN_TIMEOUT`
- `DEX_CONTROL_ORIGIN_UNCORRELATED`
- `DEX_CONTROL_ORIGIN_AMBIGUOUS`

Deterministic regressions cover early wait, exact final correlation, stale/wrong rejection, ambiguity, bounded timeout and dedupe. Real provider-origin proof remains in the provider qualifier.

### `MS-P0-07` — Managed ChatGPT worker spawn

Historical setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`.
Bootstrap conversation: `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`.

Acceptance:

- exactly one fresh managed ChatGPT target;
- exactly one intended room member;
- duplicate same-control delivery creates no second worker;
- failed/late spawn closes the temporary target and leaves no member.

Provider qualification now performs this in a disposable room with a fresh qualification ChatGPT worker.

### `MS-P0-08` — Stale setup handoff cleanup

Previously qualified. Control `provider-control-nova-phase0-stop-room-be-001` succeeded; follow-up `deferredSends: 0`. Commit `12dfec316` prevents an immediate stop receipt from presenting stale queue state as authoritative.

### `MS-P0-09` — Historical exact-once recovery — DO NOT REPLAY

- exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`
- historical state: `PROMPT_SEND_FAILED`
- recovery classification: `gesture-outcome-unknown`, capture-only

Do **not** resend it, infer its original outcome, intentionally reproduce it to clear the ledger, refresh that historical provider tab, or reload the extension merely to clear this entry.
If the original draft is visibly still present, Drift may commit that exact visible draft once; otherwise recovery remains capture-only.

## Validation history

| Gate | Evidence |
|---|---|
| Phase-0 focused matrix | prior `68/68` at `d01c3d556` |
| Rehydration/control lane | prior `45/45` with `61ea2f78a` |
| Stop/control lane | prior `24/24` with `12dfec316` |
| Full Nexus suite latest Vera rerun | `667fb61`: 1608 total, 1590 pass, 18 fail; same 18 as `main` |
| Vera supervised/Linux/pwsh flow | PASS at `667fb61` |
| Drift Windows focused MS matrix | `21/21` PASS at `0f2960e6` |
| Drift Windows CMD/PowerShell/WSL broker | PASS at `0f2960e6` |
| Drift Windows descendant tree-kill | PASS at `0f2960e6` |
| Drift extension assembly/reload/reconnect | PASS at `0f2960e6` |
| Current post-qualification source | **not yet rerun**; current bundle includes request-view, external adapter, complete-report helper and provider provenance lanes |
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

Do not refactor these as Machine Spaces work:

- `js/modules/features/audioflix/audioflix.audio.url.spotify.js`
- `server_modules/audioflix_spotify_scrape.js`
- `js/modules/features/audioflix/audioflix.audio.js`
- `js/modules/features/audioflix/audioflix.audio.url.js`
