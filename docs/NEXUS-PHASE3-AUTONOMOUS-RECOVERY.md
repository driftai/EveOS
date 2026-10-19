# EveOS supervised engineering recovery

This guide covers the two supported interfaces to one bounded TLO recovery
engine. TLO diagnoses and proposes exact edits; deterministic EveOS code owns
authority, transactional application, verification, receipts and retry safety.

## Ordinary PowerShell

Use `eve_run.py` when a command is permitted to repair a small, exact set of
repository files. TLO is checked for readiness during preflight but receives no
inference request when the first command succeeds.

```powershell
python -B tools/qualification/eve_run.py `
  --retry-safety idempotent `
  --repair-file tools/Nexus-Browser/tests/example.test.js `
  --context-file tools/Nexus-Browser/source/example.js `
  --invariant "Preserve exact request and process identities" `
  --max-attempts 1 `
  -- node --test tools/Nexus-Browser/tests/example.test.js
```

`--retry-safety never` is the default. `launch-only` permits retry only when
the child process provably never started. `idempotent` is required for a
started command to run again after an authorized repair. A timeout is always
`OUTCOME_UNKNOWN` and is never replayed automatically.

The ignored receipt is written under
`data/runtime/smoke-results/tlo-autorecovery/<run>/receipt.json`. It includes
ordered lifecycle events, every command attempt, raw bounded proposal evidence,
backups, applied paths and the final outcome.

## Dex room and Machine Spaces

1. Open Nexus Browser in Dex Mode and select the exact engineering room.
2. Enable **Human Input** and select its Machine Space.
3. Open **Prepare TLO recovery job (local owner)**.
4. Enter the pinned managed PowerShell target, exact Git HEAD, exact command,
   repair files, optional context/invariants and the bounded repair budget.
5. Confirm that the command is idempotent, then select **Prepare recovery**.
6. Review the original command and recovery authority on the queued card.
7. Select **Start supervised** and confirm the complete authority summary.

The prepared command invokes the same `eve_run.py` engine inside the pinned
managed terminal. The outer Machine Spaces job retains room, space, terminal,
process epoch and request identity. Its bounded output remains in the private
spool. A successful inner recovery receipt is projected into the room's final
Machine Spaces event.

If Nexus restarts before dispatch, the durable queued job becomes `cancelled`.
If Nexus restarts after dispatch and cannot prove the exact process outcome, the
job becomes `outcome-unknown`. Neither state is replayed automatically.

## Authority boundaries

- Human Input and a second Start confirmation are mandatory for Machine Spaces.
- Repair paths are exact regular files inside the EveOS checkout.
- TLO may make at most four exact-text edits per proposal, three proposal
  corrections per cycle and three repair cycles; the selected job may lower the
  repair-cycle budget.
- Branch, local HEAD, remote HEAD and permitted dirty paths are revalidated
  before execution, after edits and before GREEN.
- Unknown, timed-out, cancelled, stale-epoch or unauthorized work safe-stops.
- TLO never grants shell, Git, publication, package-install or deployment
  authority through conversational text.

## Acceptance map

| Scenario | Evidence owner |
| --- | --- |
| A: ordinary success/no inference | `tlo_autorecover` success path and live receipt |
| B: ordinary repair to GREEN | live disposable `eve_run.py` fixture |
| C: Machine Spaces repair to GREEN | managed-terminal recovery job and room receipt |
| D: restart/crash | durable supervised-job restart reconciliation |
| E: unauthorized repair | recovery-plan and exact-edit policy rejection tests |
| F: malformed/unavailable model | bounded proposal correction and safe-stop tests |
| G: concurrency | exact request IDs, per-target broker exclusion and isolated receipts |
| H: uncertain command | timeout/outcome-unknown no-replay contracts |
| I: regression | Nexus Browser, AI-control, guardrail and publication suites |

Passing deterministic tests proves the contracts. Final operational acceptance
also requires a disposable live TLO repair-to-GREEN receipt in both interfaces.
