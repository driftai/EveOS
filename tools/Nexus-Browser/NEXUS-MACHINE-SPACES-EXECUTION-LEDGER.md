# Nexus Machine Spaces execution ledger

This file is the durable handoff for Machine Spaces and the Dex control path that
drives it. Keep machine-local process IDs, open-tab IDs, drafts, and transient
recovery state in the ignored runtime checkpoint instead:

`data/runtime/nexus-browser/machine-spaces-checkpoint.json`

## Operating rules

- Verify the current branch, local HEAD, remote HEAD, and worktree before edits.
- Never replay an uncertain send, spawn, terminal mutation, or file mutation.
- A budget stop is not task completion. Preserve unfinished work explicitly.
- Record exact room, turn, request, and control IDs when they are evidence.
- Commit only coherent implementation work; runtime checkpoints stay untracked.
- Provider names and agent identities are distinct: ChatGPT/Eve, Codex/Nova,
  and Hark/Vera.

## Current baseline

| Field | Value |
|---|---|
| Branch | `eve/nexus-machine-spaces` |
| Last reconciled remote base | `044edb6c85284b3a12a5409630f655d1857ba4b9` |
| Current Phase-0 implementation commit | `12dfec316` |
| Worktree at checkpoint | ledger update only; runtime checkpoint is ignored |
| Runtime | Nexus Browser only; Local MoE is out of scope |
| Current phase | `MS-P0` |
| Next safe action | let exact turn `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c` recover or expire without replay, then reload the extension and qualify automatic rehydration |

## Work queue

| ID | Status | Owner | Scope |
|---|---|---|---|
| `MS-P0` | active | Nova | Control-origin finalization, worker spawning, recovery, and room cleanup |
| `MS-01` | planned | unassigned | Canonical filesystem roots and Allow Once/Persistent/Deny grants |
| `MS-02` | planned | unassigned | File tree, stat, bounded reads, line counts, and search |
| `MS-03` | planned | unassigned | Safe create/edit/patch/move/delete with hashes and atomic writes |
| `MS-04` | planned | unassigned | Persistent grants, expiry, revocation, and operation-specific capabilities |
| `MS-05` | planned | unassigned | Agent voting, quorum, availability evidence, and agent-only workflows |
| `MS-06` | planned | unassigned | Supervised servers, deferred jobs, session rebound, and trusted attach |
| `MS-07` | planned | unassigned | Collapsible Dex UI, provenance, paging, filters, and resource UX |
| `MS-08` | planned | unassigned | Destructive/exact-once security matrix and native-shell qualification |

## `MS-P0` evidence and subitems

### `MS-P0-01` — Manual-commit timer binding

- Status: landed; local browser reload completed.
- Root cause: copied browser timer functions were invoked with a plain object as
  their receiver, producing `TypeError: Illegal invocation`.
- Fix: preserve the browser-global receiver for timer calls.
- Commits: `1219df628bb172a026e8cca29d127c6a08982364`,
  `fe356146677ae2e0a9c4e5de3ab499d67751d0d5`.
- Protected invariant: an unconfirmed send is never automatically replayed.

### `MS-P0-02` — Dex tool-result submission confirmation

- Status: landed; focused tests passed before this ledger.
- Root cause: ChatGPT could render the result differently from the staged text,
  leaving a successful result submission unconfirmed.
- Fix: exact `provider-control-*` request ID is an authoritative secondary
  confirmation anchor.
- Commit: `85fbaf59818f185ef232c0d132c69ef118b4a7b3`.
- Protected invariant: one gesture only; a stale or different request ID cannot
  confirm the submission.

### `MS-P0-03` — Explicit stop cleanup

- Status: landed and live-qualified.
- Root cause: stopped rooms could retain queued deferred handoffs, preventing
  clean deletion and making the room appear busy.
- Fix: explicit stop terminalizes queued-not-delivered handoffs.
- Commits: `52e8e72db`, `96f566d27`.
- Live evidence: room `room-9b5c892d-4daf-4568-a669-6126d9e27305`
  reached `deferredSends: 0`, no recovery, no active relay, and was deleted.
- Expected late behavior: an old request against that deleted room correctly
  returns `DEX_ROOM_NOT_BOUND`; do not retry it.

### `MS-P0-04` — Provider-tab rehydration after extension reload

- Status: implementation locally qualified; new commit `61ea2f78a`; automatic
  no-refresh live proof pending.
- Root cause: after an MV3 service-worker/extension reload, an already-open
  provider tab could retain stale globals while the Dex interception content
  group was absent. Commands then rendered as ordinary ChatGPT text until a
  manual page refresh.
- Follow-up root cause reproduced locally: the old content scanner could still
  answer its legacy presence ping even though it was disconnected from the new
  MV3 worker. The rehydrator incorrectly treated that response as healthy.
- Follow-up fix: the current worker owns a random generation epoch. The control
  scanner must complete a new worker-backed handshake for that exact epoch;
  legacy/stale scripts cannot satisfy it and are reinjected in place. New
  scanners expose cleanup so future reinjections remove their observer/listener.
- Commits: `c1c415d3d`, `0e05087ed`, `d01c3d556`.
- Follow-up commit: `61ea2f78a`.
- Local evidence: unified extension rebuilt with 103 assets and
  `extension:reload` reported reconnected.
- Acceptance still required: reload the extension, do not refresh ChatGPT, and
  receive a harmless Dex status result from the already-open tab.
- Reproduction evidence: Eve's finalized proof turn created an exact pending
  `status` receipt, but no provider-control request arrived. A one-time exact-tab
  reload then produced control request
  `provider-control-767a3f28-825c-432e-9276-05e654de7155`, committed the receipt,
  and automatically advanced the queued room message.
- Tests: affected rehydration/control lane `45/45`; full Nexus Browser suite
  passed at this patch state.

### `MS-P0-05` — Hark human-command attribution

- Status: landed; focused regression exists.
- Fix: human-pasted Hark `[[DEX:CMD ...]]` text is rejected while a genuine
  Vera assistant trailing command remains eligible.
- Commit: `02cf8014c702462f72928c5a0116db60042a25b0`.

### `MS-P0-06` — Control-origin finalization

- Status: under qualification; no new fix justified yet.
- Existing design: the provider command is authorized only after an exact
  trailing command is recorded on the originating finalized agent turn.
- Existing failure codes remain fail-closed:
  `DEX_CONTROL_ORIGIN_TIMEOUT`, `DEX_CONTROL_ORIGIN_UNCORRELATED`, and
  `DEX_CONTROL_ORIGIN_AMBIGUOUS`.
- Required proof: a command observed before finalization waits, correlates to
  the exact finalized turn, and executes once; wrong/stale commands fail.
- Remaining uncertainty: transport acknowledgement currently precedes durable
  origin settlement. Determine with a focused failure/restart test whether a
  pre-final arrival can be lost, rather than redesigning from transcript alone.

### `MS-P0-07` — Managed ChatGPT worker spawn

- Status: blocked on a clean controlled live proof, not on a known source defect.
- Original setup room: `room-be09577d-69ac-4048-b4c2-fb8a8118be73`.
- Bound bootstrap target: ChatGPT conversation
  `6ac18ef7-5b68-83e9-bc6a-f7ad944096b3`.
- Do not repeat: the historical spawn attempts were made while command
  interception/correlation was unhealthy. Never infer that a missing UI member
  means an uncertain spawn is safe to replay.
- Acceptance: one fresh managed ChatGPT tab appears, one room member is added,
  and duplicate delivery of the same control request creates no second worker.
- Failure cleanup: a failed spawn closes its temporary target and leaves no
  member behind.

### `MS-P0-08` — Remaining stale setup handoff

- Status: locally qualified.
- Room `room-be09577d-69ac-4048-b4c2-fb8a8118be73` was idle but retained one
  queued deferred relay in the latest runtime snapshot.
- Live evidence: fixed control ID
  `provider-control-nova-phase0-stop-room-be-001` succeeded; authoritative
  follow-up status reported `deferredSends: 0` with no active/recovery work.
- Observation: the immediate stop receipt showed the pre-cleanup queue count.
  The follow-up status was correct. Commit `12dfec316` now reports the stop as
  accepted with `authoritativeStatePending: true`, omits the stale queue count,
  and reports a rejected stop mutation as `DEX_CONTROL_STOP_FAILED`.

### `MS-P0-09` — Current exact-once send recovery

- Status: active runtime recovery; no source replay authorized.
- Exact turn: `dex-turn-df81360e-109f-4ec1-bd84-7a7798c0502c`.
- State: `PROMPT_SEND_FAILED`, `gesture-outcome-unknown`, capture-only recovery.
- Invariant: do not resend, refresh the tab, reload the extension, or infer that
  the draft was unsent. If the original draft is visible, Drift may commit it
  once with Enter; otherwise allow the bounded recovery lifecycle to settle.
- This recovery is separate from the rehydration defect and must not be hidden
  by forced cleanup.

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

## Current validation ledger

| Gate | Result |
|---|---|
| Phase-0 focused matrix | `68/68` pass at `d01c3d556` |
| Rehydration/control affected tests | `45/45` pass with `61ea2f78a` |
| Stop/control focused lane | `24/24` pass with `12dfec316` |
| Full Nexus Browser test suite | pass with `12dfec316` |
| Unified extension assembly/audit | pass with 103 assets at `12dfec316` |
| Root structural guardrail | reached current assets and 100% smoke registration, then blocked only by pre-existing Audioflix line-growth debt listed below |

## Quota-stop protocol

1. Finish or explicitly abort the current mutation.
2. Never retry an uncertain send, spawn, terminal, or file mutation.
3. Record exact Git HEAD, worktree state, room/turn/request IDs, and recovery state.
4. Commit and push only coherent work.
5. Update the active ledger item and its next single action.
6. Store process/tab/draft/runtime facts only in the ignored checkpoint.
7. On resume, verify Git and live Nexus state before trusting either record.
8. Do not create replacement rooms merely because an existing room is stuck.

## Known unrelated gate debt

Root guardrails previously reached the file-growth gate and stopped on existing
Audioflix line-count debt. Do not refactor those files as part of Machine Spaces:

- `js/modules/features/audioflix/audioflix.audio.url.spotify.js`
- `server_modules/audioflix_spotify_scrape.js`
- `js/modules/features/audioflix/audioflix.audio.js`
- `js/modules/features/audioflix/audioflix.audio.url.js`
