# Phase 3D-C Gate 3B — Production Assembly

Date: 2026-10-24

Published Gate 3A baseline: `14b9fa8fef48b04413ebac31efaa1ff2568c9e4c`

Gate 3B source fingerprint:
`820fa5683487080c47059eaa3a7bbdd38af919cdb3c4c0a23451781ff8b61719`

Runtime boundary: source-only. No Nexus/EveOS/Local MoE restart, browser
automation, ownership transfer, real TLO inference, room mutation, commit, or
push occurred during this gate.

## Verdict

**PASS — GO for a separately authorized Gate 3C controlled activation.**

Backend inference remains default-disabled. This verdict does not authorize a
restart, handoff, activation, live model request, or publication of Gate 3B.

## Production assembly

1. `server.js` constructs one small Phase 3D production owner. It installs the
   exclusive TLO route and injects the ownership seam into the existing
   Local-Origin relay without adding another scheduler or conversation owner.
2. Browser and backend dispatch share one canonical target. Durable ownership,
   handoff, uncertainty, and activation state decide the sole advertised route;
   there is no legacy fallback after backend ownership begins.
3. The activation record is machine-local, Git-ignored, atomically written,
   mode `0600` where supported, current-session/source-bound, integrity-checked,
   and never projected into diagnostics. A bounded active lease expires after a
   Nexus owner crash; a new preparation rotates the secret.
4. Node and Python independently calculate the same source fingerprint from
   the checked-in manifest. Python accepts backend requests only when the
   activation lease and the durable owner generation agree and the exact
   request is already in `dispatched` state.
5. Browser history export and hydration use the exact registered workspace
   socket, one-use challenges, independent digest calculation, bounded history,
   and compare-before-replace semantics. Search Monitor keeps a stable
   per-tab workspace identity across reloads.
6. The internal production controller provides `preflight`, `handoff`,
   `activate`, `status`, and `rollback`. Handoff acknowledgement is one-use and
   generation-bound. Rollback refuses handoffs, pending conversation work, and
   admitted/dispatched/uncertain turns.
7. HTTP diagnostics expose only sanitized deployment/readiness, owner,
   generation, transfer, and uncertainty state.

The controls are deliberately not registered to a generic browser, HTTP, or
qualification command surface in Gate 3B. Gate 3C must invoke them through a
separately authorized one-shot activation runner so localhost access alone can
never become deployment authority.

## Deterministic evidence

- Phase 3D Node matrix including new Gate 3B cases: **122/122 PASS**.
- Server/local-target/file-size affected matrix: **14/14 PASS**.
- Python/Node production authentication smoke: **PASS**.
- Existing TLO adapter smoke: **PASS**.
- Smoke registry audit: **465/465 registered; 0 unregistered**.
- Node/Python source fingerprint comparison: **exact match**.
- Runtime activation path: confirmed ignored by repository policy.

The new cases cover default-disabled startup, registration ordering, concurrent
owner rejection, direct-route fencing, browser history integrity, reopen
hydration, one-use challenges, lost acknowledgements, HMAC replay, prepared
token expiry, mixed source, stale owner generations, crash-before/after-
dispatch fencing, disabled transport, and rollback refusal with unresolved
work.

## Remaining live boundaries

- The new production source has not been loaded into running services.
- Real browser export/hydration and real process restart recovery remain to be
  proven in Gate 3C.
- No browser-closed TLO inference has run; that remains the later Gate 4 proof.
- Windows ACL behavior relies on the existing per-user runtime directory in
  addition to best-effort private file mode; Gate 3C preflight must confirm the
  actual file owner and access list before writing credentials.
- Any uncertain dispatch blocks activation rollback and automatic replay; it
  requires evidence-based reconciliation through the existing Dex journal.

## Gate 3C stop conditions

Stop before inference if source fingerprints differ, the 14-room/readiness
preflight changes unexpectedly, the activation record is incomplete or stale,
both routes appear authoritative, history digests diverge, a handoff
acknowledgement is lost, or any turn is pending/unknown. Never delete or reset
durable ownership records to force activation.
