# Dex terminal outcome reliability — 2026-10-18

Scope: local presentation and exact-outcome correlation on `eve/nexus-machine-spaces`.

- New scheduler final receipts persist `sourceMessageId` alongside the existing turn and final message IDs, including recovery finals.
- Scheduler failure messages carry `relayFailure`, `sourceMessageId`, and `turnRequestId`. Terminal `check` distinguishes `TURN_FAILED`, `TURN_OUTCOME_UNKNOWN`, in-flight and final receipt states. Historical room failure messages are interpreted only within an uncontested user segment.
- Live partial-response text is an ephemeral, bounded read-only projection of the **current** scheduler turn; it does not persist model streams or grant new agent powers. The TUI labels it as an unconfirmed preview and separately confirms the final receipt.
- The TUI reports status transitions and 15-second heartbeat, uses bounded polling and a 195-second local watcher window, and never resends a committed or uncertain message automatically. The backend and original scheduling policies remain authoritative.
- Terminal CLI `wait` recognizes settled failures and unknown outcomes rather than waiting only for success.

Validation: focused deterministic tests. Full `npm run verify`, Windows interactive TUI and live Search Monitor reconnect acceptance **not yet qualified**; do not promote to `main`. The two historical pending provider-control receipts are not mutated.
