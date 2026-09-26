# Nexus Machine Spaces: Local Native Qualification Report

## 1. Environment & Target Baseline
- **Repository Branch:** `eve/nexus-machine-spaces`
- **Tested Base SHA:** `53458cb7ae999d1eec6297ba498dac7f52de91c7`
- **Canonical Main Reference:** `71fb6d6d1c6665c0436da15ba085c63ab371f76c` (untouched)
- **Live Bridge Supervisor:** PID 35428 on port 9088 (active, undisturbed)
- **Operating System:** Windows 11 host with WSL2 (Ubuntu)

## 2. Test Verification Totals
- **Focused Suite:** 16/16 passed
  - `machine-spaces-terminal-inventory.test.js`: 6/6 passed
  - `dex-task-completion.test.js`: 7/7 passed
  - `dex-exact-local-binding.test.js`: 3/3 passed
- **Full Nexus Subsystem Suite:** 1,105/1,105 passed (`node --test tools/Nexus-Browser/tests/*.test.js`)
- **Structural Guardrails:** `npm run --silent test:guardrails` PASS (1,856 assets checked, 393/393 smoke registry clean, file growth limits respected)
- **Formatting Hygiene:** `git diff --check` Clean (exit code 0)

## 3. Native Feasibility Conclusions

### A. Antigravity Presence Lock & Session Continuity Across PID Changes
- **Tested Capability:**
  Live inspection of the Windows 11 host confirms `agy.exe` (PID 25032) holds an exclusive Win32 file lock on `~/.gemini/antigravity-cli/presence/<conversationId>.lock`. The conversation ID (`f6f51c43-72c4-4e02-8611-3ca2a4e8dc77`) is permanent across machine reboots, whereas OS PIDs recycle upon restart. Probing presence lock file ownership uniquely identifies which live PID owns an authorized conversation session.
- **Untested / Proposed Rule:**
  Automatic PID rebinding has not yet been enabled in the scheduler. Rebinding must remain fail-closed unless the candidate process is verified to hold the exclusive lock for the exact registered conversation ID.

### B. Independent Post-NOTE Task Completion Producer
- **Tested Capability:**
  The server completion engine (`dex/server-task-completion.js`) and journal (`dex/task-completion-journal.js`) have been fully verified with synthetic signed payloads. When a signed completion matching the task ID, expected Git SHA, and secret token arrives at `task-completions/reports/<taskId>.json`, the server tick ingests it, validates credentials, and enqueues the payload directly into `inboxQueue` once the room settles (`relayActive: false`).
- **Untested / Proposed Rule:**
  An autonomous out-of-band external runner process producing this signed signal without manual operator invocation has not yet been executed in a live Dex relay turn. The autonomous producer script remains a planned Phase 1 implementation.

### C. Terminal Attachment Capabilities
- **Tested Capability:**
  Only the **existing interactive Antigravity CLI terminal** (`local-origin / local-antigravity-existing`) is verified for console attachment via Win32 `AttachConsole` (`tools/Nexus-Browser/local-targets/console-helper-transport.js`).
- **Untested / Infeasible via Dynamic Scraping:**
  External arbitrary Windows CMD, PowerShell 7, and WSL2 bash terminals have NOT been verified for dynamic console attachment. Win32 `AttachConsole` cannot hook modern Windows Terminal ConPTY pipes without dll injection, causes input keystroke collision with human operators, and cannot cross the WSL2 Hyper-V VM boundary.
- **Architectural Requirement:**
  All generic terminal targets in Nexus Machine Spaces must be spawned as **managed sessions** (ConPTY or redirected stdio child processes governed by Windows Job Objects). External scraping remains strictly restricted to pre-existing interactive Antigravity CLI sessions.
