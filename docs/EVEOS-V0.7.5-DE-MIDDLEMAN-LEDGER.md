# EveOS V0.7.5 De-Middleman Initiative — owner and acceptance ledger

This ledger is the Phase 0 source map for the V0.7.5 De-Middleman Initiative.
It is intentionally an integration ledger, not a competing framework.

## Baseline and branch policy

- Working lane: `eve/nexus-machine-spaces`.
- Phase 0 inspection baseline: `606210ce23b9af4749c8dedaa97c9a56106a46b3`.
- `main` remains untouched unless Drift explicitly requests otherwise.
- Publication is non-force only. Re-read the remote branch immediately before publication and require the expected old SHA to match.
- A source result is not published merely because an earlier SHA was green. Required evidence must apply to the exact source being published.
- Generated evidence, credentials, PIDs, tab IDs and machine-local state remain under ignored runtime storage; do not commit them.

## Initiative invariant

V0.7.5 connects, generalizes and exposes machinery EveOS already owns. It must not create parallel schedulers, parallel authorization planes, parallel evidence systems or parallel browser-control frameworks merely because a new feature needs them.

Target operating model:

```text
conversation / agent = command + reasoning
local machine         = execution
Git                   = transactional state
JSON/log/trace        = evidence / machine memory
GitHub                = durable publication
```

The end state is an authorized closed loop:

```text
agent task
  -> exact Nexus actor / room / target / authority
  -> Navigator discovery
  -> Machine Spaces inspect / execute / edit
  -> browser robot where applicable
  -> deterministic + browser/native evidence
  -> structured execution receipt
  -> GREEN
  -> coherent commit
  -> authorized non-force push
  -> remote exact-SHA readback
  -> result delivery to the requesting agent
```

Drift remains the authority and supervisor, but should not need to ferry commands and output between the agent and the machine.

## Existing owner inventory

| Capability | Existing owner / source | V0.7.5 treatment | Phase 0 state |
|---|---|---|---|
| Dex room scheduling, exact target identity and durable relay state | `tools/Nexus-Browser/` runtime and Dex modules; `DEX-MODE.md`; `DEX-DURABLE-INBOX.md` | Extend in place. Never create a second scheduler. Preserve exact request IDs, durable FIFO, recovery journals and no-replay-on-uncertainty behavior. | `DONE` owner identified |
| Online-Origin provider delivery and extension bridge | `tools/Nexus-Browser/extension/`, provider adapters, localhost bridge | V0.7.1A adds durable stage/outcome observability around the existing owner. Extension/service-worker memory is never sole authority. | `DONE` owner identified |
| Machine Spaces authorization, filesystem capabilities, terminal/process supervision and request audit | `tools/Nexus-Browser/machine-spaces/`; `NEXUS-MACHINE-SPACES-EXECUTION-LEDGER.md` | This remains the action/authority plane. Navigator may discover, but Machine Spaces authorizes and revalidates current targets. | `DONE` owner identified |
| Machine Spaces deterministic/live qualification | `tools/Nexus-Browser/scripts/machine-spaces-*-qualify.js`, provider provenance qualifier and `package.json` qualification scripts | Reuse and compose. Do not duplicate current Windows/provider/native boundaries. | `DONE` owner identified |
| Detached exact-once task qualification | `tools/Nexus-Browser/scripts/task-completion-runner.js` plus Dex task-completion journal/auth modules | Generalize toward the shared V0.7.1B execution/evidence contract. Keep immutable registration, exact branch/SHA gate, allowlisted stages and uncertain-start fail-closed behavior. | `DONE` owner identified |
| Nexus handoff snapshot | `tools/Nexus-Browser/scripts/handoff.js` and Dex handoff packet | Extend rather than replace. Current strict rollover assumes `main`; active-lane exact-head semantics are a known V0.7.1B gap. | `DONE` owner identified; gap recorded |
| Failure diagnostics | `tools/Nexus-Browser/scripts/failure-snapshot.js`, bridge doctor and receipt inspector | Feed structured evidence/receipts. Diagnostics are evidence, not authorization. | `DONE` owner identified |
| Durable repository qualification drivers | `tools/qualification/`, `tools/smoke/`, repository tests and setup verify/doctor | Reuse as deterministic and subsystem-specific evidence. Live/native/provider qualification remains explicitly separate. | `DONE` owner identified |
| Browser qualification | existing Nexus headed/live qualification plus subsystem browser acceptance drivers | V0.7.2 creates shared registered robot-user primitives by extracting/generalizing existing behavior, not by adding arbitrary provider-supplied JavaScript execution. | `DONE` owner family identified; shared primitive owner still to be selected |
| TLO/local model assistance | existing Local MoE/TLO integration and Nexus Local-Origin target model | Optional bounded triage/summarization/test assistance. TLO is not an authority, scheduler or required delivery dependency. | `DONE` boundary identified |

## Authority boundaries that V0.7.5 must preserve

1. **Dex/Nexus owns routing and delivery truth.** A provider or future middle agent may summarize, classify, coalesce or prioritize, but cannot create authority by text.
2. **Machine Spaces owns local mutation authority.** Filesystem/process/terminal actions must remain grant-, provenance- and target-scoped.
3. **Navigator is discovery/cache, never truth.** Any result used for read/patch/run must be revalidated against the current authorized target and current file identity/hash where applicable.
4. **The middle-agent slot is provider-agnostic and per-room.** TLO, ChatGPT, Claude, Gemini, Grok, DeepSeek, Muse or another registered provider/member may occupy it. If it disappears, deterministic routing continues.
5. **Browser automation has an evidence boundary.** Playwright/headed browser proof does not stand in for physical-phone, native compositor/GPU, provider-account or hardware proof it cannot actually observe.
6. **Qualification contexts and operational sessions are different.** Disposable browser state does not make real backend/account mutations disposable.
7. **Publication is transactional.** No force push; no blind replay; exact-head evidence and remote readback are part of completion.

## Shared execution/evidence target

V0.7.1B should evolve the existing task-completion, Machine Spaces job/operation and handoff owners toward one versioned plan/receipt contract.

Minimum execution plan fields:

- repository and working directory;
- authorized branch and expected HEAD/upstream/origin;
- allowed and protected files/data;
- protected hashes when required;
- requested actions;
- deterministic tests;
- browser/live/native qualification level;
- commit policy;
- push policy.

Minimum receipt fields:

- starting and final SHA;
- worktree state before/after;
- changed files;
- `completed`, `failed`, `pending` and `uncertain` stages;
- commands, results and durations;
- browser/native evidence references;
- integrity checks and evidence invalidation when inputs change;
- commit result;
- push result;
- remote exact-SHA readback;
- remaining uncertainty.

Canonical repair/publication progression:

```text
INSPECT
  -> RED / FALSIFIER when repairing
  -> REPAIR
  -> FOCUSED GREEN
  -> STRUCTURAL GREEN
  -> BROWSER / LIVE / NATIVE PROOF where required
  -> EXACT-HEAD CHECK
  -> COMMIT
  -> NON-FORCE PUSH ONLY IF GREEN
  -> REMOTE READBACK
  -> RECEIPT
```

## Known Phase 0 gaps / next targets

### V0.7.1A — delivery observability

The existing bridge already distinguishes several transport/commit states, but V0.7.1A must expose one durable per-command lifecycle with exact request identity and stage age:

```text
accepted
  -> dispatched
  -> execution started
  -> execution completed
  -> result persisted
  -> notification attempted
  -> delivered | failed | uncertain
```

Test the existing duplicate-suppression/result-notification ordering rather than assuming its failure mode. Do not remove duplicate suppression and do not auto-replay an uncertain notification.

### V0.7.1B — active-lane handoff/publication semantics

`handoff:verify` currently encodes strict `main` rollover semantics. V0.7.1B needs a versioned execution-plan rule that can verify an explicitly authorized working branch and exact expected remote SHA without weakening main rollover safety.

### V0.7.2 — shared browser robot

Select the existing browser helper/qualification owner to receive reusable registered actions/scenarios (`open_surface`, `click_control`, `inspect_geometry`, `capture_screenshot`, `collect_console`, `check_visible_state`, etc.). Do not expose arbitrary provider-origin JavaScript as the control contract.

### V0.7.3 — Navigator

Extend Machine Spaces with a versioned discovery protocol. First implementation should favor a small Windows-capable path/name + exact-content stack and benchmark before adding a heavyweight persistent content index. Navigator failure must degrade to existing files/terminal/jobs behavior rather than taking Machine Spaces down.

## Release acceptance ledger

Status vocabulary is only `DONE`, `BLOCKED`, `DEFERRED`, or `UNQUALIFIED`.

Current checkpoint: `9c4c61e428ff0a582321ce314ea6d775f371cc5f` on
`eve/nexus-machine-spaces`. Phase 0 was published and read back successfully.
V0.7.1A's deterministic owner family and captured-final/Dex-ACK boundary are
green, but a real extension-worker restart/reconnect pass has not yet been
recorded for this exact checkpoint, so the milestone remains `UNQUALIFIED`
rather than being promoted from unit evidence alone.

| Milestone | Acceptance | Status |
|---|---|---|
| Phase 0 owner inventory | Existing execution, authority, delivery, qualification, handoff and diagnostics owners are mapped without introducing duplicate frameworks. | `DONE` |
| Phase 0 publication-path proof | This ledger is committed to `eve/nexus-machine-spaces` from the exact inspected baseline using a non-force expected-SHA lease, then read back from the resulting remote SHA. | `DONE` at `3b389f2eb3ce0df80bcc20be5cc2af1034fb4e74` |
| V0.7.1A | Durable per-command stage/outcome observability survives extension worker/runtime restart and distinguishes execution from result notification. | `UNQUALIFIED`; deterministic lifecycle/correlation/watchdog/captured-ACK coverage is green through `9c4c61e42`, live extension restart remains |
| V0.7.1B | One versioned execution plan + receipt contract composes existing handoff, task-completion and Machine Spaces owners; exact-head green publication is proven. | `UNQUALIFIED` |
| V0.7.2 | One authorized real task completes the golden execution -> browser evidence -> receipt -> commit -> non-force push -> remote readback loop without Drift as command/output relay. | `UNQUALIFIED` |
| V0.7.3 | Navigator is integrated into Machine Spaces with freshness/auth/revalidation/degraded-mode guarantees and Windows nasty-path/restart/corrupt-index proof. | `UNQUALIFIED` |
| V0.7.4 | Provider-agnostic per-room middle-agent role and Nexus traffic/TUI controls operate over deterministic existing authority; middle-agent loss degrades safely. | `UNQUALIFIED` |
| V0.7.5 | Shared patterns are adopted/proven in AudioFlix, Nexus/Dex, Machine Spaces, WatchFusion, Bookmarks/INSITE and at least one data/content surface. | `UNQUALIFIED` |

## Proliferation review

Every meaningful V0.7.5 repair or qualification ends with:

```text
PROLIFERATION REVIEW
Reusable technique discovered? YES/NO
Existing shared owner?
Promoted helper/contract?
Other benefiting subsystems?
Regression proving shared behavior?
```

A proliferation review identifies reusable work; it does not silently authorize unrelated scope expansion.

## V0.7.1B — Governor evidence visibility (bounded candidate)

The existing Agent Governor's ignored `receipt.json` records can now be
projected through the **existing Machine Spaces supervised controller** to a
read-only owner UI. The projection is local-UI-only, scans a bounded history,
and explicitly excludes mission content, logs, paths, credentials and source
file lists. It neither starts nor retries work; Dex and Machine Spaces retain
their separate routing and mutation authority.

This is an initial evidence-visibility slice, **not** the completed shared
execution/receipt contract. Real supervised task binding, durable notification,
crash/restart qualification and live browser/provider proof remain `UNQUALIFIED`
until exercised on the authorized Windows machine. The accompanying Governor
Git-porcelain fix preserves the status prefix used to identify modified files.

## V0.7.1B — Bounded Governor supervised execution binding

The existing Machine Spaces supervised-job controller now accepts a **local-owner-only**
structured Governor plan (exact room, space, attached managed PowerShell target,
expected HEAD, ignored-runtime mission/run ID, and explicit allowlisted files).
It builds a fixed Governor CLI command server-side, rejects shell/path injection,
records the job through the **existing** supervised coordinator, and leaves it
queued until Human Input and local Start authorization. Before starting, it
revalidates the pinned target and mission SHA-256. It cannot publish implicitly.
Governor remains sole owner of live quota/model-effort policy, actual inference,
qualification, evidence, and separate Git publication authorization.

This is NOT yet the no-middleman golden workflow: the initial preparation UI is
local owner controlled, the supervised job ledger is process-lifetime, and real
crash/restart/reconnect, real provider control, and delivery acceptance are
still `UNQUALIFIED`. Durable Governor receipts remain separate read-only evidence,
not proof that a supervised process survived or delivered its final result.
