# Nexus Machine Spaces execution ledger

This file is the durable handoff for Machine Spaces and the Dex control path that
drives it. Keep machine-local process IDs, open-tab IDs, drafts, and transient
recovery state in the ignored runtime checkpoint instead:

`data/runtime/nexus-browser/machine-spaces-checkpoint.json`

## Operating rules

- Verify the current branch, local HEAD, remote HEAD, and worktree before edits.
- Never replay an uncertain send, spawn, terminal mutation, file mutation, or supervised job.
- A budget stop is not task completion. Preserve unfinished work explicitly.
- Record exact room, turn, request, control, grant, job, target, and process-epoch IDs when they are evidence.
- Commit only coherent implementation work; runtime checkpoints stay untracked.
- Provider names and agent identities are distinct: ChatGPT/Eve, Codex/Nova, and Hark/Vera.
- Source/test implementation is not live qualification. Never promote a stage on source evidence alone.

## Current baseline

| Field | Value |
|---|---|
| Branch | `eve/nexus-machine-spaces` |
| Reconciled implementation HEAD before this ledger commit | `0598b0cc4c7b7c854b81c0659a63bdd1bb2c98a9` |
| Runtime | Nexus Browser only; Local MoE is out of scope |
| Current live blocker | `MS-P0` exact-origin/managed-worker qualification |
| Current build lanes | `MS-05` through `MS-08` source implementation and qualification |
| CI attached to `0598b0cc` | none reported by GitHub |
| Next safe action | run the current Nexus test suite/extension assembly locally; do not disturb the unresolved exact-once recovery to do so |

## Work queue

| ID | Status | Owner | Scope |
|---|---|---|---|
| `MS-P0` | active-live-qualification | Eve/Nova/Vera | Control-origin finalization, worker spawning, recovery, room cleanup |
| `MS-01` | source-implemented | Eve + prior work | Canonical filesystem roots and human Allow Once/Persistent/Deny grants |
| `MS-02` | source-implemented | Eve + prior work | File tree, stat, bounded reads, line counts/search primitives |
| `MS-03` | source-implemented | Eve + prior work | Safe create/edit/patch/move/delete with hashes and atomic writes |
| `MS-04` | source-implemented | Eve + prior work | Persistent grants, expiry, revocation, capability-specific permissions |
| `MS-05` | active-qualification | Eve | Agent voting, quorum, availability evidence, agent-only workflows |
| `MS-06` | active | Eve | Supervised servers, deferred jobs, session rebound; trusted external attach still pending |
| `MS-07` | active | Eve | Existing collapsible request UX plus provenance/filter/paging view model; UI integration remains |
| `MS-08` | active-qualification | Eve | Cross-stage destructive/exact-once matrix added; native live-shell qualification remains |

## 2026-10-08 continuation checkpoint

### Filesystem foundation — `MS-01` through `MS-04`

The branch already contained the generalized filesystem foundation before the current MS-05/MS-08 pass:

- `machine-spaces/filesystem-broker.js`
- `machine-spaces/filesystem-provider-control.js`
- `machine-spaces/capability-grant.js`
- `machine-spaces/server-controller-filesystem.js`
- `extension/content/machine-file-actions.js`

Protected source invariants include canonical repository scoping, bounded reads/search,
symlink/path escape rejection, SHA-256 mutation preconditions, atomic writes, exact target
scoping, allow-once consumption, persistent expiry/revocation, and operation-specific capabilities.
The local panel owns grant creation/revocation; agent provider-control consumes only granted authority.

### `MS-05` — Agent quorum and agent-only workflows

Status: source implemented; focused regressions added; local/live qualification still required.

Implemented:

- `agent-quorum.js`: fixed Eve/ChatGPT, Nova/Codex, Vera/Hark identity map; fresh presence TTL;
  expected/required agent sets; deterministic majority; approve/deny/abstain votes; exact control-ID
  dedupe; conflicting reuse rejection; one vote per agent; audit snapshots.
- `agent-quorum-provider-control.js`: exact relay-origin provenance, authenticated provider/agent binding,
  and `quorum_presence`, `quorum_open`, `quorum_vote`, `quorum_status`, `quorum_close`.
- `server-controller-quorum.js`: Machine Spaces controller/provider-control integration.
- `extension/content/machine-quorum-actions.js`: provider content registration across online providers.

Commits:

- `f3893f5a13bec408f2f2182b18fefe85a3dbff29`
- `0558f81d17aa9c3c10d54f8f6d9c0e41ee6621ce`
- `1a57e3f8f00c445aec706a0cb2831c0ab5b0b20e`
- `780aeb1767aadd580f4190054b77f9f9f93bbaa3`
- `e9ffc55f00eb1adb73847b61bea68248d8cf7ab9`
- `48f447cca5998e12511747bfb2b28130ebc71dab`
- `dd348598ff8a20598dc3eacf5eb6533b762e965c`
- `77e5d1b0ceee525315203577c88d48bf016b9ece`
- `99c3613e2c0638a39ca363a6a897ef2980ea7b03`

Do not weaken: command payload identity never substitutes for the authenticated provider source plus exact
originating Dex member/message. Human-pasted text is not agent availability or a quorum vote.

### `MS-06` — Supervised jobs and session rebound

Status: active. Managed supervised execution and rebound safety exist; trusted attachment to arbitrary
pre-existing external terminals is intentionally still `false`/pending.

Implemented:

- `supervised-job.js`: exact request ownership, target/process-epoch pinning, queued/running/deferred/
  terminal states, rotating supervision leases, stale-lease rejection, deferred-on-session-loss,
  target-loss `outcome-unknown`, and audit events.
- `managed-terminal-broker.js`: long-running supervised mode on the same managed-terminal resource as
  bounded commands; 8-hour default supervision ceiling; bounded retained output without killing a healthy
  server; stale epoch rejection; interrupts/timeouts settle uncertain.
- `supervised-job-provider-control.js`: agents may `job_prepare`, `job_status`, `job_list`; provider-control
  deliberately has no remote launch/rebound action.
- `server-controller-supervised.js`: only local UI sockets may launch/rebound/cancel. Local socket loss defers
  its running jobs. Rebound is accepted only when the broker can prove the same supervised request remains
  active on the same target/process epoch; otherwise replay is refused.
- `extension/content/machine-job-actions.js`: provider content registration.

Commits:

- `490e74b9f8f20d31528aa15d5449ff268c2a4f82`
- `b3007aa5d943ef755df0e459f2f8018137ec3ee9`
- `9ccda2a91b0e11d3941b3a13df2147a9d607c34e`
- `022502908c7486f7753bc6a403632e507599c9e5`
- `9915a7dc53aa78c24f9dfcbe8db396ee5f7b0eb2`
- `76a1d026141cc6e21176aa1d281ffb12e65402fa`
- `55f7956c952bcfa43f4eab34bb509dc5f0cd7ff6`
- `4a3ecccbab33fc3962e5cb7cd3c17880d4675ffa`
- `f92a34a6a86cc243143d5f3613f9e4b13e468b4f`
- `1cfa4ef9e3a9f56a2f99bae5f6afc46d2d0f80ce`
- `2fde102d8a9b8deec7876f26aaf29c1324b2c5d8`

Protected invariant: reconnecting a browser/session is never authority to replay a command. Rebound only
reattaches supervision to a process that Nexus can still prove is the original managed process.

### `MS-07` — Provenance, paging and filters

Status: active.

Existing UI already provides collapsible earlier-request history, terminal/filesystem request cards, bounded
output paging, resource/grant controls, and compact provenance metadata.

Added `machine-spaces/request-view.js` plus regressions as a reusable view model for the next UI pass:

- merges terminal, filesystem, and supervised work;
- stable newest-first ordering;
- live/kind/state/actor/query filters;
- exact request/source-member/source-message/target/process-epoch/grant/digest/output provenance;
- stable opaque cursor pagination without boundary duplication.

Commits: `e120246b17e37ae1b58e77185e778c3be71995ab`, `1be5eec17f435ff43791ac27faf63accc87d889f`.

Remaining: connect the view model and supervised-job controls/cards into the visible Machine Spaces panel;
add explicit user-facing filters/paging controls without regressing the current collapsible history UX.

### `MS-08` — Destructive/exact-once security matrix

Status: active qualification.

Added `tests/machine-spaces-security-matrix.test.js` at `0598b0cc4c7b7c854b81c0659a63bdd1bb2c98a9`.
It covers:

- filesystem root, target, capability, expiry, revocation and allow-once consumption;
- agent/provider spoof rejection and stale quorum availability;
- absence of provider-side supervised launch/rebound authority;
- immutable supervised request IDs;
- explicit argv contracts for CMD, Windows PowerShell, pwsh and WSL;
- stale process-epoch rejection;
- same-terminal exclusion between bounded and supervised execution.

Required before marking locally qualified: run `npm test` in `tools/Nexus-Browser`, assemble/audit the unified
extension, and run focused/native-shell gates on Windows/WSL. GitHub reports no attached commit-status checks
for `0598b0cc`; tests added in this pass have not been claimed as executed by this ledger.

## `MS-P0` evidence and subitems

### `MS-P0-01` — Manual-commit timer binding

- Status: landed; local browser reload completed.
- Root cause: copied browser timer functions were invoked with a plain object as their receiver, producing
  `TypeError: Illegal invocation`.
- Fix: preserve the browser-global receiver for timer calls.
- Commits: `1219df628bb172a026e8cca29d127c6a08982364`, `fe356146677ae2e0a9c4e5de3ab499d67751d0d5`.
- Protected invariant: an unconfirmed send is never automatically replayed.

### `MS-P0-02` — Dex tool-result submission confirmation

- Status: landed; focused tests passed before this ledger.
- Fix: exact `provider-control-*` request ID is an authoritative secondary confirmation anchor.
- Commit: `85fbaf59818f185ef232c0d132c69ef118b4a7b3`.
- Protected invariant: one gesture only; stale/different request IDs cannot confirm submission.

### `MS-P0-03` — Explicit stop cleanup

- Status: landed and live-qualified.
- Fix: explicit stop terminalizes queued-not-delivered handoffs.
- Commits: `52e8e72db`, `96f566d27`.
- Live evidence: `room-9b5c892d-4daf-4568-a669-6126d9e27305` reached `deferredSends: 0`, no recovery,
  no active relay, and was deleted.
- Old requests against that deleted room correctly return `DEX_ROOM_NOT_BOUND`; do not retry them.

### `MS-P0-04` — Provider-tab rehydration after extension reload

- Status: implementation locally qualified at prior checkpoint; automatic no-refresh live proof pending.
- Fix: worker-generation handshake prevents stale content scanners from satisfying current-worker health;
  stale scripts are reinjected in place and old observers/listeners are disposed.
- Commits: `c1c415d3d`, `0e05087ed`, `d01c3d556`, `61ea2f78a`.
- Prior local evidence: unified extension rebuilt with 103 assets and `extension:reload` reconnected.
- Acceptance still required: reload extension, do not refresh ChatGPT, receive harmless Dex status from the
  already-open tab.
- Prior reproduction control request after one exact-tab reload:
  `provider-control-767a3f28-825c-432e-9276-05e654de7155`.

### `MS-P0-05` — Hark human-command attribution

- Status: landed; focused regression exists.
- Human-pasted Hark `[[DEX:CMD ...]]` text is rejected while genuine Vera assistant trailing control remains eligible.
- Commit: `02cf8014c702462f72928c5a0116db60042a25b0`.

### `MS-P0-06` — Control-origin finalization

- Status: under live qualification; no replay authorized.
- Existing fail-closed codes: `DEX_CONTROL_ORIGIN_TIMEOUT`, `DEX_CONTROL_ORIGIN_UNCORRELATED`,
  `DEX_CONTROL_ORIGIN_AMBIGUOUS`.
- Required proof: an early command waits for exact finalization and executes once; matching late command is
  accepted; stale/wrong commands remain rejected.
- Remaining uncertainty: transport acknowledgement may precede durable origin settlement. Qualify with a
  focused failure/restart test instead of redesigning from transcript evidence.

### `MS-P0-07` — Managed ChatGPT worker spawn

- Status: clean controlled live proof pending.
- Original setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`.
- Bootstrap conversation: `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`.
- Never infer that a missing member means an uncertain historical spawn is safe to replay.
- Acceptance: exactly one fresh managed ChatGPT tab, exactly one room member, duplicate same-control delivery
  creates no second worker; failed spawn closes temporary target and leaves no member.

### `MS-P0-08` — Remaining stale setup handoff

- Status: locally/live qualified at prior checkpoint.
- Fixed control ID `provider-control-nova-phase0-stop-room-be-001` succeeded; follow-up status reported
  `deferredSends: 0` with no active/recovery work.
- Commit `12dfec316` reports stop as accepted with `authoritativeStatePending: true` and avoids stale queue data.

### `MS-P0-09` — Current exact-once send recovery

- Status: unresolved runtime recovery; **no source replay authorized**.
- Exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`.
- State: `PROMPT_SEND_FAILED`, `gesture-outcome-unknown`, capture-only recovery.
- Invariant: do not resend, refresh the tab, reload the extension, or infer that the draft was unsent merely
  to clear this record. If the original draft is visibly present, Drift may commit that same draft once with
  Enter; otherwise allow the bounded recovery lifecycle to settle.
- This recovery is separate from later Machine Spaces source work and must not be hidden by forced cleanup.

## Phase-0 regression matrix

| Requirement | Current evidence |
|---|---|
| Early exact command waits for finalization and executes once | focused tests exist; rerun at current HEAD |
| Exact matching late command accepted | focused tests exist; live proof pending |
| Wrong/stale turn rejected | focused tests exist |
| Same control ID deduplicated | routing tests exist |
| Existing drafts preserved | ChatGPT manual-commit tests exist |
| Failed result injection remains queryable | result journal/status tests exist |
| Failed spawn closes temporary target | routing failure tests exist |
| Stop terminalizes queued-not-delivered work | landed and live-qualified |
| Stopped room becomes deletable | landed and live-qualified |
| Human-pasted Hark command rejected | landed regression |
| Managed ChatGPT worker appears once in exact room | live proof pending |

## Validation ledger

| Gate | Result |
|---|---|
| Phase-0 focused matrix | prior `68/68` pass at `d01c3d556`; rerun required at current HEAD |
| Rehydration/control affected tests | prior `45/45` pass with `61ea2f78a` |
| Stop/control focused lane | prior `24/24` pass with `12dfec316` |
| Full Nexus Browser suite | prior pass with `12dfec316`; current MS-05/MS-08 additions not executed in this checkpoint |
| Unified extension assembly/audit | prior pass with 103 assets at `12dfec316`; rerun required after new content scripts |
| GitHub status checks at `0598b0cc` | none attached |
| Root structural guardrail | prior run reached current assets and 100% smoke registration, then blocked by unrelated AudioFlix line-growth debt |

## Quota-stop protocol

1. Finish or explicitly abort the current mutation.
2. Never retry an uncertain send, spawn, terminal, file mutation, or supervised job.
3. Record exact Git HEAD, worktree state, room/turn/request/control/grant/job IDs, and recovery state.
4. Commit and push only coherent work.
5. Update the active ledger item and its next single action.
6. Store process/tab/draft/runtime facts only in the ignored checkpoint.
7. On resume, verify Git and live Nexus state before trusting either record.
8. Do not create replacement rooms merely because an existing room is stuck.

## Known unrelated gate debt

Root guardrails previously stopped on pre-existing AudioFlix line-count debt. Do not refactor these files as
part of Machine Spaces:

- `js/modules/features/audioflix/audioflix.audio.url.spotify.js`
- `server_modules/audioflix_spotify_scrape.js`
- `js/modules/features/audioflix/audioflix.audio.js`
- `js/modules/features/audioflix/audioflix.audio.url.js`
