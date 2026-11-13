# Engineering Efficiency Guardrails

This file is the canonical efficiency/reliability workflow for EveOS Nexus Browser.

The goal is to keep proven fast paths, exact-once behavior, and qualification discipline from being lost during later feature work. Future changes should extend these rules instead of quietly replacing them.

## Canonical change workflow

Use this shape for normal remote-first/local-proof engineering:

```powershell
Set-Location tools/Nexus-Browser  # From the EveOS root

git status --short
git pull --ff-only origin main
git rev-parse HEAD

node --test <focused tests for the changed area>

npm run validate:shared
```

`npm run validate:shared` is the shared deterministic gate:

1. `npm run stabilize`
2. `npm run providers:verify`
3. `npm run doctor`

Run focused tests first so quota/time is spent on the changed area before the shared gate.

Do not replace this with repeated full-suite runs unless the change actually requires them.

## Extension validation + reload is a first-class command

For extension/service-worker/content-adapter changes, preferred:

```powershell
npm run extension:refresh
```

That command is intentionally the normal agent handoff path. It runs:

1. `npm run validate:shared`
2. `npm run extension:reload`

Do not ask Drift to manually open Chrome's extensions page or click Reload when this automated path is available and healthy.

Reload-only, when validation has already just passed:

```powershell
npm run extension:reload
```

Equivalent lower-level command:

```powershell
node scripts/dexctl.js reload-extension
```

The wrapper waits for the real extension disconnect -> reconnect cycle before returning success.

A raw `node -e "...WebSocket...reload_extension..."` command is fallback/debug plumbing only. It is not the normal user-facing workflow.

Restarting the localhost tools/server is not the same as reloading the Chrome extension service worker.

When extension/service-worker/content-adapter code changes, reload the extension before headed qualification.

When provider content-adapter behavior changes, bump `extension/content/provider-adapter-revision.js` so already-open provider tabs cannot silently keep stale injected code.

## Runtime efficiency invariants

### 1. Streaming activity must stay cheap

Provider activity/partial-response events may refresh in-memory timeout/progress state immediately, but they must not force a whole-room durable snapshot write and full-state broadcast on every sample.

The current fast path deliberately bounds durable lease checkpoints instead of persisting every 350-400 ms provider partial.

Do not regress to per-partial synchronous JSON serialization/disk writes.

If room size increases and supervisor health failures rise with it, treat event-loop starvation/state persistence as a first-class suspect before increasing health timeouts.

### 2. Localhost owns execution

The deterministic localhost scheduler owns:

- queue execution
- exact target selection
- timeout/retry decisions
- recovery
- durable dispatch state
- relay-budget consumption

The headed Dex page is a controller/viewer, not the execution scheduler.

Do not move hot execution ownership back into the browser UI.

### 3. Exact-once is load-bearing

The durable turn ledger records the dispatch boundary before provider/local side effects.

Once dispatch may have occurred:

- never automatically resend the prompt;
- recover by capture/observation only;
- preserve exact target identity;
- fail closed when evidence is insufficient.

Qualification must continue to prove one dispatch attempt, one provider submission, zero duplicate sends, and no relay-budget double decrement.

### 4. Recovery timeout must not orphan late authoritative finals

Active interrupted-turn recovery is bounded.

When active recovery times out:

- stop active polling;
- keep a passive exact-once recovery journal for a late provider final;
- terminalize the ledger timeout so diagnostics do not accumulate a new zombie-active turn;
- allow a later authoritative final for that same request to advance the ledger to completed and stitch the reply without restarting the relay.

Do not discard the recovery journal at the active-poll timeout boundary.

### 5. Recovery polling is not a state-sync flood

Recovery polling must be paced and must not recreate the old multi-second full-room persistence storm.

Do not reduce the polling/checkpoint intervals without evidence that the additional churn is needed and safe.

### 6. Qualification may model real provider navigation without weakening pre-send authorization

Before a qualification prompt is sent, the target must still match the exact authorized run/provider/tab/URL.

After the one-shot exact-once prompt claim commits, the same owned provider tab may legitimately navigate to a generated conversation URL (for example ChatGPT `/c/...`).

Adopt same-provider post-commit navigation; do not weaken pre-send authorization.

### 7. Fresh provider tabs may hydrate in stages

A provider may expose a provisional/pre-hydration composer before the real chat controls are ready.

Qualification may re-open/rehydrate the exact safe Chat surface and reseed the harmless qualification marker, but must not create an extra submit path.

Exact-once qualification still permits only its intended single provider submission.

Ordinary ChatGPT sends must also tolerate a provisional composer disappearing during fresh-page hydration. Re-find the current composer and reseed the prompt before submission; never treat a transient remount as proof that the provider received the prompt.

A fresh ChatGPT root conversation may navigate from `/` to `/c/...` immediately after submission, destroying the original page watcher. The service worker must preserve the original request identity and capture-recover the final from that exact tab without resending the prompt.

Navigation capture recovery must use the same conservative completion semantics as the page watcher. Never finalize merely because a partial capture stayed unchanged for a short fixed window; require reliable generation-end settling, complete-looking text with the normal no-signal settle, or the long incomplete no-signal settle.

ChatGPT transient/status activity is not reliable completion evidence. If the current substantive text is structurally incomplete, keep the long incomplete-text settle even when the watcher previously saw only status-derived activity; never downgrade fragments to the short status settle.

### 8. Resumed qualification must rebind late provider events

A supervised qualification restart replaces the localhost server process while the provider tab can keep generating.

After `qualification_resume`, the new server must re-bind the persisted `promptClaimedRequestId` to the resumed qualification socket. If the original provider watcher later emits its authoritative `response_final`, route that event to the recovery controller and finish immediately. Capture polling remains the fallback when that final was emitted before the resume rebind.

Do not let a restarted qualification depend only on capture polling while discarding request-specific late provider events.

Qualification recovery capture must also resolve the exact owned tab/provider from the persisted qualification run itself. It must not depend on whatever provider tab happens to be globally selected after restart.

### 9. Provider-control mutation ACKs are durable boundaries

A successful state-mutating provider-control result must not outrun the Dex state snapshot that contains that mutation.

On the primary Dex socket, flush the updated state before sending `provider_control_result`. WebSocket frame ordering then guarantees localhost receives and synchronously saves the mutation before the caller can observe success and issue the next mutation.

Do not replace this with arbitrary sleeps in callers or soak tooling. Read-only provider-control commands must not force whole-state flushes.

### 10. Adapter freshness is part of correctness

Changing a content adapter without advancing the shared adapter revision can leave already-open tabs on stale code.

Treat adapter revision bumps as part of the patch whenever existing provider tabs must receive new injected adapter behavior.

### 11. Online managed workers stay bounded and localhost-orchestrated

An Online-Origin agent may create a fresh managed browser worker only through `spawn_agent`; it must not emulate this with terminal commands, arbitrary browser automation, or a reused existing chat.

Managed-worker invariants:

- only registry-declared spawnable providers may be created;
- spawning requires an explicit authorized room and a verified Online-Origin source;
- create a brand-new background tab with `active:false`; never reuse, focus, or steal the parent agent's selected chat;
- if a provider declares a managed-worker readiness probe, require stable non-destructive first-turn readiness before binding the worker into Dex;
- localhost owns spawn correlation, mutation dedupe, rollback, and exact target cleanup;
- keep a small global managed-worker cap (currently 4);
- bind managed workers by exact spawned tab identity until their provider conversation URL stabilizes;
- a trailing provider-control command pauses the current relay before the mutation runs; only the exact agent holding that turn may receive the short settle-to-idle wait;
- ordinary `remove_agent` and room deletion must not orphan managed tabs; use `despawn_agent` so the exact provider tab is closed;
- if an uncommitted spawn finishes late or cannot be routed to Dex, close it instead of leaking an orphan worker;
- a correct first worker reply is not the end of a managed-worker proof: on that reply turn do not emit `[[DEX:DONE]]`; issue read-only room `status` and begin closure;
- closure requires exactly one worker reply with the proof token, no duplicate dispatch, no target drift, no pending/recovery state, exact `despawn_agent` of that member, and one final room `status` proving the worker is gone and the room is idle;
- create managed-worker proof rooms with `disposable:true` and `purpose:"managed-worker-proof"`; after the final idle status, delete the disposable proof room with `delete_room`; one-use qualification/test rooms must not accumulate after their proof is finished;
- room deletion is allowed only after managed workers are despawned and the room is idle; preserve the existing fail-closed `DEX_CONTROL_MANAGED_WORKERS_PRESENT` and `DEX_CONTROL_ROOM_BUSY` guards;
- the user-facing closing report must include the exact deleted room id/result as well as managed-tab cleanup, exact validated SHA, worker/member identity, proof turn/token, duplicate/drift/recovery evidence, and any remaining limitation;
- only after worker cleanup, disposable-room deletion, and that closing report may the managed-worker proof be called complete.

This is an orchestration layer above the existing localhost scheduler. It must not become a second scheduler or weaken exact-once dispatch/recovery rules.

### 12. Prompt delivery needs an explicit commit proof

Typing the prompt into a provider composer is not delivery.

For adapters that opt into the shared prompt-delivery verifier:

- verify the intended prompt is actually seeded into the current composer before any submit side effect;
- permit exactly one submit side effect for that dispatch;
- prefer the provider's real send control when available;
- mark the submit attempt before invoking the control so a thrown/cancelled click remains an uncertain post-dispatch state;
- require a committed user turn containing that prompt before reporting delivery success;
- composer departure or an empty text box is evidence only, not a commit proof;
- after any submit side effect has been attempted, never fall through to another click, form submit, or Enter action for the same dispatch;
- an unproven submission must fail as `PROMPT_DELIVERY_UNCOMMITTED` and remain capture/observation-only.

The extension should preserve delivery-proof details on `prompt_accepted` and on adapter errors so the ledger/incident path can distinguish typed-only, attempted, and committed states.

## Eve Engineering line rollover

Engineer numbers are lineage labels only. Engineer 3, Engineer 12, or Engineer N must all begin from the same current evidence contract rather than inheriting authority from an older chat.

Use:

```powershell
npm run handoff
```

for an ordinary current-state packet.

Before intentionally ending one engineering chat and promoting its state to the next engineer, prefer:

```powershell
npm run handoff:verify
```

The strict rollover command fetches `origin/main`, requires the local branch to be `main`, requires a clean worktree, and requires local HEAD to equal the freshly fetched `origin/main`. It still prints the packet on failure so the next engineer can see the mismatch, but the command exits non-zero.

The packet's `engineeringLine` section is the durable Eve Engineering N contract. It defines:

- current repo/runtime/log evidence above old chat theory;
- repo-native project rules above generalized workflow examples;
- durable Library workflows as procedure, not a store for volatile SHAs or runtime state;
- REFINE -> MERGE -> COMPRESS -> DELETE -> only then ADD;
- Eve-first remote/source work and scarce local-agent quota reserved for real runtime proof;
- the exact evidence bundle required when a theory fails;
- the exact completion receipt required before work is called complete;
- Wren Muse Main and Growth/production continuity as protected non-fixtures;
- a next-agent acknowledgment shape so the new engineer grounds itself before speculative editing.

A rollover packet is not a completion certificate. Only the exact SHA/state actually validated at the required local/headed boundary may be called complete.

## Failure evidence snapshots

After a headed/runtime failure, collect evidence before changing the theory or retrying an uncertain side effect:

```powershell
npm run diagnose
npm run diagnose -- --request-id <id> --room-id <id> --provider <provider>
```

The snapshot correlates the live `/diagnostics` state, active/specified room, incident tail, turn-ledger tail, bounded server-terminal snippets, and the newest qualification-log failure excerpt. The supervised server mirrors its visible stdout/stderr into `data/runtime/nexus-browser/server.log`; this is evidence plumbing, not a replacement for the visible terminal.

Managed spawn failures must preserve their structured browser-side detail across localhost routing and record a spawn incident with the lifecycle phase, exact tab/provider identity, requested URL, and last observed URL before cleanup. Do not flatten structured failure detail into a message-only error.

When the server or supervisor changed, restart through `START.bat` before relying on these sensors. A content/service-worker-only extension reload does not reload localhost or the supervisor.

## Qualification order

After deterministic gates are green:

1. Reload the extension if extension code changed.
2. Run disposable live qualification for the affected provider(s).
3. Run warm-target qualification where supported.
4. Run `npm run doctor`.
5. Run a headed soak with no intentional supervisor restart when validating the false-watchdog-restart class.

Canonical command:

```powershell
npm run soak:headed -- --list-targets
npm run soak:headed -- --chatgpt-tab-id <unbound-chatgpt-id> --muse-tab-id <unbound-muse-id>
```

The soak must use explicit provider tabs that are not already bound to any Dex room and are fresh disposable conversation surfaces. ChatGPT must begin at `https://chatgpt.com/`; Muse must begin at `https://muse.ai/thread/new`. Existing unbound conversations are not valid soak targets because their prior model context can emit Dex control markers or otherwise contaminate the transport test.

Before real relay traffic, the harness primes each fresh disposable surface with a neutral plain-text echo and waits for its conversation URL to stabilize. The prime marker must not resemble Dex relay-control syntax. This keeps provider first-message navigation outside the scheduler stress window while preserving the no-intentional-restart requirement.

It creates and deletes a temporary room, disables its Local-Origin source from relay participation, seeds the room to meaningful serialized-state size, alternates ChatGPT and Muse through the real localhost scheduler, requires one-dispatch/completed ledger outcomes, and fails if the localhost server session or incident count changes.

The headed soak must also verify reply content integrity, not just reply counts. Each relay response must be exactly `SOAK_ACK[dex-turn-...]`, and the ACK request-id set must equal the durable ledger request-id set. The closing bracket is intentional: it gives ChatGPT an unambiguous completion shape so transport timing tests do not spend a minute waiting on punctuation heuristics. Inactive `Dex Transport Soak ...` rooms may be removed only through the guarded `--cleanup-stale` path. Cleanup is offline-only: stop the bridge, run the cleanup command against persisted state, then restart. Never generalize that maintenance path to production rooms.

Do not use Growth/production room bindings or existing conversation history as soak targets.

A supervised live-qualification restart proves recovery invariants; it does not by itself prove spontaneous watchdog restarts are gone.

When multiple pre-existing ready provider tabs make warm qualification ambiguous, do not guess and do not require hidden UI selection state. Re-run with `--warm-tab-id <id>` to pin an exact pre-existing ready tab. The pin must still satisfy provider match, pre-existence, policy, readiness, no-focus-steal, and exact-once rules.

## Test-target discipline

Do not use an important long-lived room as a qualification fixture when disposable or dedicated warm provider targets are available.

In particular, a paused Growth/production room with an unresolved composer or recovery question stays untouched until its state is classified.

Never manually press Enter on a stranded provider composer merely to advance a test.

## Anti-bloat rule

Prefer existing project commands and helpers over ad-hoc replacements.

Before inventing a new one-liner or script, check whether `scripts/dexctl.js`, npm scripts, qualification helpers, or existing deterministic tooling already own that operation.

If a lower-level command is useful for debugging, keep it as fallback plumbing and preserve the higher-level canonical command.

## 2026-09-19 efficiency checkpoint

The reliability pass that motivated these guardrails established these concrete lessons:

- repeated supervisor health failures correlated with large-room streaming activity and synchronous whole-state persistence pressure;
- bounded lease persistence removed the per-partial durable-write pattern;
- recovery polling was slowed and timeout now transitions to passive late-final watch instead of discarding exact-once context;
- Muse warm exact-once qualification proved one submission, capture recovery, no duplicate dispatch, no relay-budget double decrement, and no focus steal;
- fresh Muse qualification hydration and same-provider ChatGPT post-commit URL transitions are handled by the qualification layer rather than weakening production targeting;
- extension adapter revisioning is required so provider tabs actually receive adapter changes.

This checkpoint is a behavior contract, not a permanent commit pin. Future HEADs may change; these invariants should remain unless a later change explicitly replaces them with something demonstrably safer and more efficient.


### 15. Disposable-room maintenance is local and fail-closed

Use `npm run rooms:cleanup-disposable` to reclaim stale managed-worker proof rooms left by older runs. This maintenance path is localhost-only; do not grant online agents cross-room cleanup authority. It deletes only rooms explicitly tagged `lifecycle.disposable=true` with kind `managed-worker-proof`, plus the two pre-tagging legacy proof rooms `Managed Worker Live Proof` and `Managed Worker Live Proof R15`. Busy, pending, or recovery rooms are skipped. Any Dex-managed browser target must close successfully (or report already closed) before its room can be removed. Production rooms and unrelated rooms are never candidates.
