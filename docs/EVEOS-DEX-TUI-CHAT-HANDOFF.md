# EveOS · Nexus TUI — next-chat handoff

**Last updated:** 2026-10-18. **Project:** [driftai/EveOS](https://github.com/driftai/EveOS), Windows local workspace `C:\Users\alvin\Documents\Workspace\RoughProjDeving\EveOS`.

## Immediate mission
Finish qualification of the **Dex terminal reply reliability fixes**, then qualify one live TLO chat, and move on to the globally launchable **`dex-tui`** (room picker, Dex and Base Mode navigation, Machine Spaces, receipts, restart controls). The user explicitly wants the TUI to be a primary terminal-native Nexus front end—not a one-room proof script.

## Hard constraints
- Work **only** on `eve/nexus-machine-spaces`; never merge or force-push `main`, never overwrite or reset unrelated local changes.
- Keep release eligibility fail-closed, honor the 440-line source growth guard, and never bypass permissions, Human Input locks, or grants.
- Only the user can run Windows commands and observe local Nexus; GitHub-connected assistant may commit to the branch and furnish explicit PowerShell acceptance instructions.
- Preserve exactly-once send/receipt semantics: after uncertain outcomes, inspect exact original request ID; never blind-resend.
- Nexus supervised restart works via `cd tools/Nexus-Browser; npm run restart` but **invalidates in-memory managed terminal sessions**; TLO room Machine Space must be rebound afterward. Coordinate restarts to avoid disrupting running work.

## Confirmed work and results
- TLO room: `room-ca675f10-d03d-414d-b5e3-3ec6c0bd63de`; Machine Space: `machine-space-247a8a0f-825c-47a6-be6d-020154772388`.
- Prior rebinding generated target `terminal-powershell-5b6630cb-8690-47e9-b67c-f20bce6dbf06` and returned `ATTACHMENT_VERIFIED`; this **is not a permanent target ID** across restarts.
- Interactive TUI succeeded with TLO replies; one message `dex-terminal-7b9b685b-a098-4fea-b5e8-8e91df2dffe9` failed because Search Monitor workspace disconnected. Later replies took ~10–18s end-to-end and were not proven to be slow TUI rendering.
- TUI reliability patch `7305f31fdb0592d25a96ff585af0e2d5b4fe910c` and corrective patch `23b5040f6ff5b0be769a26ced8bbd56ba0611817` add source-correlated finals, failures, progress previews, 195s watcher, no automatic replay, legacy status compatibility. **25/25 focused tests passed** locally on `23b5040`.
- Qualification runner fix `5aaa4f96fdc3567a46df929d50bc9856d091bf7e` replaced fragile 120ms speed-ratio self-test. User ran **3/3 self-tests PASS**.
- Full `npm run verify` on `5aaa4f9` STOPPED at guardrails (1/41): `tools/Nexus-Browser/dex/server-scheduler.js` grew **440 → 450 lines**, violating `first_party_file_growth_guard.js`. Release ineligible.
- Subsequent pending patch refactors **read-only scheduler diagnostics and terminal-live projection** to `dex/server-scheduler-telemetry.js` without relaxing the guard or changing scheduling. See current remote branch HEAD; the exact new commit is intentionally not hard-coded here.

## Next-chat instructions
1. Ask user to run or inspect the most recent local results capsule using `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\qualification\eveos_nexus_tui_handoff.ps1 -IncludeFailureTails`. It writes a Markdown handoff under `$env:TEMP` and copies its content to clipboard. User can paste it into the new conversation or attach the generated file. **Do not claim cross-chat automatic delivery. Review failure tails for sensitive contents before sharing.**
2. Verify current `eve/nexus-machine-spaces` remote SHA before any changes. Pull fast-forward only into a clean worktree.
3. Run targeted `node --test` including `dex-terminal-outcome-reliability.test.js`, `dex-terminal-operator.test.js`, `dex-room-tui-chat.test.js`, `dex-room-general-send.test.js`, `server-scheduler-telemetry.test.js`. Run `node tools/smoke/first_party_file_growth_guard.js`.
4. Run `npm run verify` (full 41-gate local qualification). If FAIL, use the report + exact failing gate log; do not change unrelated areas speculatively.
5. Only then perform supervised restart + reattach if necessary, qualify TLO live replies and Search Monitor disconnect behavior, then start the `dex-tui` app.
6. Two old `MS Provider Proof` rooms have unresolved historical `quorum_presence` provider-control receipts. The user inspected them as `QUIESCENT_PENDING_UNCERTAIN`, not disposable. Do not mutate to silence diagnostics.

## Local artifacts
- Latest full verification report: `data/runtime/smoke-results/timed-qualification/verify-*/report.json` and sibling gate logs.
- User's previous failing run: `verify-20261018T234355933661Z`; gate `guardrails` failure as above.
- Canonical TUI change ledger: `docs/EVEOS-DEX-TERMINAL-OUTCOME-RELIABILITY.md`.

## How to share this in a new ChatGPT conversation
Paste the output of `eveos_nexus_tui_handoff.ps1` and say: **"Continue EveOS Nexus TUI qualification from this handoff; preserve branch and unrelated work."** A new conversation cannot see this chat's current PowerShell output unless it is shared or accessible through connected sources.
