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

The ignored receipt is written at
`data/runtime/smoke-results/tlo-autorecover-<timestamp>-<nonce>/receipt.json`. It includes
ordered lifecycle events, every command attempt, raw bounded proposal evidence,
backups, applied paths and the final outcome.

## Dex room and Machine Spaces

For the room-first path, select a room whose middle-agent slot is currently
bound to TLO, enable **Human Input**, select its Machine Space, and send one of
these explicit messages:

```text
/recover tools/path/to/script.js
run this script with recovery: tools/path/to/script.ps1
run tools/path/to/script.py with recovery
```

The shortcut intercepts ordinary Dex Send/Enter handling, so it does not
dispatch a chat/model turn. After the local owner confirms retry safety, localhost
prepares one inert recovery job against the room's sole EveOS-rooted managed
PowerShell target. Wait for the matching job receipt; do not blindly resend. Nothing executes until the
local owner reviews the card and confirms **Start supervised**. Version 1 accepts
one repository-relative `.js`, `.mjs`, `.cjs`, `.py`, `.ps1`, `.cmd`, or `.bat`
script and no arbitrary arguments.

By default, starting a room-issued job requests a visible read-only PowerShell
view that mirrors the managed terminal's output. The Nexus-managed hidden process
remains the sole execution, interruption, receipt, and retry owner; typing in the
viewer cannot run commands. If the optional viewer cannot open, the managed job
continues under the same authority and receipt contract. The viewer is optional
for the detailed manual form.

The room shortcut is implemented and regression-qualified. The live Scenario C
receipt below proves the detailed manual Machine Spaces path; a separate live
`/recover` shortcut run has not been recorded.

The detailed manual path remains available:

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
If the bounded TLO repair budget is exhausted, the final receipt is marked
`owner-required` and the room receives the bounded failure evidence. Nexus does
not schedule another middle-agent turn or replay the command.

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

## Final acceptance receipt — 2026-10-19

The shared recovery implementation was accepted at `4ce1f53a7`, followed by
the exact live-receipt projection correction at `1c58ddd78`.

| Scenario | Result |
| --- | --- |
| A: ordinary success/no inference | PASS — one command attempt, zero repair proposals, `tlo-autorecover-20261019T125659-b126ca29/receipt.json` |
| B: ordinary repair to GREEN | PASS — failure, one authorized edit, targeted retry, GREEN, `tlo-autorecover-20261019T125721-a03f1cb3/receipt.json` |
| C: Machine Spaces repair to GREEN | PASS — Playwright local-owner preparation and second Start confirmation; job `machine-job-b3572798-a515-4809-96c5-eff958e059c7`; room receipt `tlo-autorecover-20261019T130401-0fd101fd/receipt.json`; zero browser errors |
| D: restart/crash | PASS — durable restart reconciliation cancels never-started work and marks active work outcome-unknown without replay |
| E: unauthorized repair | PASS — exact branch, HEAD, target, cwd, path, symlink and retry-authority rejections |
| F: malformed/unavailable model | PASS — bounded JSON extraction/correction and fail-closed TLO preflight/proposal handling |
| G: concurrency | PASS — immutable request IDs, per-target exclusion, isolated receipts and stale-epoch rejection |
| H: uncertain command | PASS — timeout and unconfirmed interruption become outcome-unknown and are never replayed |
| I: regression | PASS — Nexus Browser 1835/1835, Dex qualification, AI-control 14/14, root Nexus smoke 4/4, publication guardrails and 463/463 smoke registration |

The three receipt paths are ignored machine-local evidence. The table records
their accepted identities without making private model output or mutable runtime
state part of Git. Mode A and Mode B now exercise the same recovery engine and
both have a real failure → authorized repair → targeted verification → safe
retry → GREEN proof.
