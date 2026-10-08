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
- Source implementation, test coverage, local qualification, and live qualification are separate states.
- Commit only coherent source work. Runtime state and credentials stay untracked.

## Current checkpoint

| Field | Value |
|---|---|
| Branch | `eve/nexus-machine-spaces` |
| Implementation HEAD before this ledger commit | `18a5e53c6e1f49545715d09f8e9a0fb4af92ea7c` |
| Divergence from `main` | `52 ahead / 0 behind` at implementation HEAD |
| GitHub status checks | none attached to implementation HEAD |
| Runtime | Nexus Browser only; Local MoE is out of scope |
| Main unresolved live blocker | `MS-P0` exact-origin / managed-worker live qualification |
| Current safe next action | run the current Nexus suite + extension assembly locally, then perform only the bounded live proofs listed below |

## Roadmap state

| ID | Status | Source state / remaining proof |
|---|---|---|
| `MS-P0` | active-live-qualification | cleanup/rehydration/correlation fixes exist; exact managed-worker proof and one unresolved recovery remain |
| `MS-01` | source-implemented | canonical repo roots + local Allow Once/Persistent/Deny grants exist |
| `MS-02` | source-implemented | tree/stat/bounded read/search primitives exist |
| `MS-03` | source-implemented | hash-guarded create/write/patch/move/delete + atomic writes exist |
| `MS-04` | source-implemented | capability grants, expiry, revocation, once-use consumption exist |
| `MS-05` | source-implemented / qualification pending | Eve/Nova/Vera identity, presence, voting, quorum and agent-only provider controls wired |
| `MS-06` | source-implemented / adapter-live-proof pending | supervised jobs/rebound wired; trusted external attach trust plane wired, execution intentionally not granted |
| `MS-07` | source-implemented / UX qualification pending | collapsible history existed; provenance view model + supervised job panel/output paging added |
| `MS-08` | source-implemented / qualification pending | destructive/exact-once matrix + native shell argv contracts added; Windows/WSL live gates remain |

## MS-01 through MS-04 — Filesystem capability plane

Key source:

- `machine-spaces/capability-grant.js`
- `machine-spaces/filesystem-broker.js`
- `machine-spaces/filesystem-provider-control.js`
- `machine-spaces/server-controller-filesystem.js`
- `extension/content/machine-file-actions.js`

Protected behavior:

- canonical repository-root scoping;
- exact target scoping;
- read/search bounds;
- path/symlink escape rejection;
- SHA-256 mutation preconditions;
- atomic write/replace behavior;
- operation-specific capabilities;
- allow-once consumption;
- persistent expiry and owner revocation;
- provider controls may consume only authority already granted by the local owner.

## MS-05 — Agent quorum and availability

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

Security/integrity rules:

- Eve must originate from ChatGPT, Nova from Codex, Vera from Hark.
- Mutating quorum actions require exact committed Dex room/member/message provenance.
- Availability evidence expires; stale presence cannot vote.
- Same control ID is idempotent only for the exact same vote; conflicting reuse is rejected.
- One agent cannot cast a second independent vote in the same workflow.
- Required-agent and majority rules are deterministic.
- Human-pasted provider text is not agent presence and cannot vote.

Main commits: `f3893f5a`, `0558f81d`, `1a57e3f8`, `780aeb17`, `e9ffc55f`, `48f447cc`, `dd348598`, `77e5d1b0`, `99c3613e`.

## MS-06 — Supervised servers, rebound, trusted attachment

### Supervised jobs

Implemented source:

- `machine-spaces/supervised-job.js`
- `machine-spaces/supervised-job-provider-control.js`
- `machine-spaces/server-controller-supervised.js`
- supervised mode in `machine-spaces/managed-terminal-broker.js`
- `extension/content/machine-job-actions.js`

Provider actions intentionally stop at:

- `job_prepare`
- `job_status`
- `job_list`

Provider controls do **not** expose start/rebound/interrupt. Local UI controls own those mutations.

Protected behavior:

- request ID owns one immutable command digest;
- exact target + process epoch pinning;
- queued/running/deferred/completed/failed/cancelled/outcome-unknown lifecycle;
- rotating supervision lease;
- stale lease settlement rejected;
- local supervision socket loss defers work without replay;
- rebound succeeds only while the broker can prove the same supervised request remains alive on the same target/process epoch;
- target loss terminalizes active work as `outcome-unknown`;
- supervised and ordinary commands contend for the same exact terminal resource;
- long-running output is bounded/truncated locally without killing a healthy server merely for log volume;
- interrupt/timeout is never reported as successful completion.

Main commits: `490e74b9`, `b3007aa5`, `9ccda2a9`, `02250290`, `9915a7dc`, `76a1d026`, `55f7956c`, `4a3ecccb`, `f92a34a6`, `1cfa4ef9`, `2fde102d`.

### Trusted external terminal attachment trust plane

Implemented source:

- `machine-spaces/trusted-terminal-attachment.js`
- `machine-spaces/server-controller-trusted-attach.js`

Rules:

- only local UI sockets can register/revoke adapter credentials or create/revoke attachments;
- adapter credential is generated locally and returned once; snapshots expose adapter IDs, never secrets;
- challenge is bound to exact target ID, process epoch, adapter ID, cwd and shell type;
- proof is HMAC-based using a credential resolved independently on the server;
- challenge is one-time and expires;
- revoking the adapter credential invalidates its attachments and in-flight challenges;
- trusted attachment capabilities are currently `observe` and `interrupt` only;
- `execute` is deliberately not trusted for external terminals.

This is the trust/control plane, not a claim that arbitrary Windows Terminal processes can already be driven.
A real external terminal adapter still needs to transport the challenge/proof and implement observe/interrupt.

Main commits: `0828ddaa`, `4298783c`, `b8cf4217`, `fcfc3e01`, `31cbe5b7`, `79fe761e`, `0cf2644d`, `18a5e53c`.

## MS-07 — Machine Spaces UX, provenance, paging and filters

Existing UI already had:

- collapsible earlier-request history;
- terminal + filesystem request cards;
- local grant/resource controls;
- bounded output paging;
- compact request provenance.

Added:

- `machine-spaces/request-view.js`: unified terminal/filesystem/supervised projection, stable newest-first ordering, live/kind/state/actor/query filters, exact provenance fields, stable cursor pagination;
- `public/machine-supervised-jobs-ui.js`: visible supervised-job section with queued/running/deferred/terminal states;
- human-gated Start/Reattach/Interrupt buttons;
- reattach copy explicitly states that the command is not replayed;
- bounded output viewer with Load More;
- read-only output remains viewable while Human Input is locked;
- `server-http.js` injects the companion after the existing Machine Spaces UI without rewriting the large static index.

Main commits: `e120246b`, `1be5eec1`, `6977857b`, `52b741b5`, `5ef6303a`, `409d8c3c`.

Remaining UX qualification: run the panel in the headed Nexus browser and verify room switching, Human Input lock/unlock,
queued launch, disconnect→deferred, safe rebound, interrupt, output paging and detached/attached workspace behavior.
Generic request-view filters are source-ready but are not yet promoted as the primary visible request list.

## MS-08 — Destructive/exact-once security matrix

`tests/machine-spaces-security-matrix.test.js` plus focused stage tests cover source-level invariants for:

- filesystem root/target/capability mismatch;
- grant expiry/revocation and allow-once consumption;
- agent/provider identity spoof rejection;
- stale quorum availability;
- exact control/request dedupe/conflict behavior;
- provider inability to remotely launch/rebound supervised jobs;
- stale target/process epoch rejection;
- same-terminal race prevention;
- explicit argv contracts for CMD, Windows PowerShell, pwsh and WSL;
- trusted adapter registration/attestation/revocation and no external execute authority;
- supervised UI authority/load/paging boundaries.

Do not mark MS-08 locally qualified until the current branch runs:

1. `cd tools/Nexus-Browser && npm test`
2. unified extension assembly/audit/reload gates used by this repo
3. focused Windows PowerShell/CMD/pwsh/WSL native-shell tests on the real machine
4. headed UI supervised-job flow
5. bounded live P0 proofs below

GitHub had no attached status checks at implementation HEAD; this ledger does not claim the newly added tests were executed remotely.

## MS-P0 durable evidence

### Landed/live-qualified cleanup

- `MS-P0-01` manual-commit timer receiver fix: `1219df628`, `fe3561466`.
- `MS-P0-02` exact provider-control request ID as secondary submission confirmation: `85fbaf598`.
- `MS-P0-03` explicit stop terminalizes queued-not-delivered handoffs: `52e8e72db`, `96f566d27`.
  Live cleanup room: `room-9b5c892d-4daf-4568-a669-6126d9e27305`; reached `deferredSends: 0`, no recovery, no active relay, then deleted.
- `MS-P0-05` human-pasted Hark commands rejected while genuine Vera trailing commands remain eligible: `02cf8014c702462f72928c5a0116db60042a25b0`.
- `MS-P0-08` stale setup handoff cleanup used fixed control ID `provider-control-nova-phase0-stop-room-be-001`; follow-up reported `deferredSends: 0`. `12dfec316` avoids presenting stale immediate-stop queue state as authoritative.

### Rehydration proof still required

`MS-P0-04` source uses a worker-generation handshake so stale content scanners cannot satisfy a current-worker health check.
Commits: `c1c415d3d`, `0e05087ed`, `d01c3d556`, `61ea2f78a`.

Prior local evidence: unified extension assembled with 103 assets and extension reload reconnected.
Live acceptance still required: reload extension, **do not refresh ChatGPT**, then receive a harmless Dex status result from the already-open tab.
Historical control request after an exact-tab reload: `provider-control-767a3f28-825c-432e-9276-05e654de7155`.

### Control-origin finalization proof still required

`MS-P0-06` remains live-qualification work. Fail-closed codes include:

- `DEX_CONTROL_ORIGIN_TIMEOUT`
- `DEX_CONTROL_ORIGIN_UNCORRELATED`
- `DEX_CONTROL_ORIGIN_AMBIGUOUS`

Required proof: early exact command waits for finalization and executes once; exact matching late command is accepted; stale/wrong turn is rejected; duplicate same control ID does not execute twice.

### Managed ChatGPT worker proof still required

`MS-P0-07`:

- original setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`
- bootstrap conversation: `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`

Acceptance: exactly one fresh managed ChatGPT tab, exactly one intended room member, duplicate same-control delivery creates no second worker, and failed spawn closes its temporary target with no member left behind.
Never infer that a missing UI member makes an uncertain historical spawn safe to replay.

### Unresolved exact-once recovery — DO NOT REPLAY

`MS-P0-09` remains an unresolved runtime recovery:

- exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`
- state: `PROMPT_SEND_FAILED`
- recovery: `gesture-outcome-unknown`, capture-only

Do **not** resend it, refresh that provider tab, reload the extension to clear it, or infer the draft was unsent.
If the original draft is visibly present, Drift may commit that same draft once with Enter; otherwise allow the bounded recovery lifecycle to settle.
This record must not be hidden by later Machine Spaces source progress.

## Prior validation evidence

These are historical proofs, not current-HEAD proofs:

| Gate | Prior result |
|---|---|
| Phase-0 focused matrix | `68/68` at `d01c3d556` |
| Rehydration/control lane | `45/45` with `61ea2f78a` |
| Stop/control lane | `24/24` with `12dfec316` |
| Full Nexus Browser suite | passed with `12dfec316` |
| Unified extension assembly/audit | passed with 103 assets at `12dfec316` |
| Current implementation HEAD GitHub checks | none attached |

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
