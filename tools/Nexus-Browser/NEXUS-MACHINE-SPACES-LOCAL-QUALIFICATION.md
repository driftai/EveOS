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
  Live inspection of the Windows 11 host confirms `agy.exe` (PID 25032) holds an exclusive Win32 file lock on `~/.gemini/antigravity-cli/presence/<conversationId>.lock`. The lock name contains a stable conversation identifier (value intentionally redacted). Windows PIDs can recycle after restart. The observed exclusive lock links the inspected live PID to that session at the time of inspection; unique continuity after an actual PID change or machine restart remains unverified.
- **Untested / Proposed Rule:**
  Automatic PID rebinding has not yet been enabled in the scheduler. Rebinding must remain fail-closed unless the candidate process is verified to hold the exclusive lock for the exact registered conversation ID.

### B. Independent Post-NOTE Task Completion Producer
- **Tested Capability:**
  The server completion engine (`dex/server-task-completion.js`) and journal (`dex/task-completion-journal.js`) have been fully verified with synthetic signed payloads. Synthetic tests verified ingestion of a signed report at `task-completions/reports/<jobId>.json`, matching immutable task/job identity, registered job type, expected Git SHA and private token. When the requester is idle and its exact bound tab is available, the existing delivery module performs a one-shot provider notification with an explicit ACK—not an automatic insertion into the room relay inbox. A queued/claimed notification is not proof of model receipt.
- **Untested / Proposed Rule:**
  An autonomous out-of-band external runner process producing this signed signal without manual operator invocation has not yet been executed in a live Dex relay turn. The autonomous producer script remains a planned Phase 1 implementation.

### C. Terminal Attachment Capabilities
- **Tested Capability:**
  Only the **existing interactive Antigravity CLI terminal** (`local-origin / local-antigravity-existing`) is verified for console attachment via Win32 `AttachConsole` (`tools/Nexus-Browser/local-targets/console-helper-transport.js`).
- **Untested / Infeasible via Dynamic Scraping:**
  External arbitrary Windows CMD, PowerShell 7, and WSL2 bash terminals have NOT been verified for dynamic console attachment. Generic Windows Terminal / ConPTY scraping, collision-free external terminal input and cross-WSL attachment were not qualified. Treat these as unsupported until a separately verified native adapter exists; do not infer that process discovery establishes an attachable or writable terminal.
- **Architectural Requirement:**
  All generic terminal targets in Nexus Machine Spaces must be spawned as **managed sessions** (ConPTY or redirected stdio child processes governed by Windows Job Objects). External scraping remains strictly restricted to pre-existing interactive Antigravity CLI sessions.

## 4. Qualification provenance and redaction
- These are Astro-reported local observations and deterministic test totals; they are not a live deployment qualification of the new Machine Spaces feature.
- The observed conversation identifier must not be copied into logs, public reports or remote prompts; use a locally retained digest/opaque enrollment reference instead.
- A historical documentation commit included an identifier. Redacting the current file does not remove it from immutable Git history; repository-history remediation, if needed, requires separate coordinated authorization and must not silently rewrite the active branch.
