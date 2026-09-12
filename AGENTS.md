# EveOS Agent Rules

These rules apply to development and verification across EveOS.

## Architecture

- Keep first-party source modules at or below 450 physical lines. Split by responsibility instead of hiding logic in generated blobs.
- Preserve domain boundaries. EveOS may own lifecycle, status, state, theme, and shared contracts while specialized tools keep their own runtimes when that isolation is useful.
- Never kill a local process merely because it owns an expected port. Verify the service identity first.
- Treat `main` as the canonical development line unless the user explicitly asks for a branch.
- `config/eveos-ports.json` is the single source of truth for EveOS-owned service ports. New services must register an environment key, label, and unique port there instead of introducing a new literal port in a launcher or lifecycle controller.
- Environment port overrides are allowed for qualification/debugging, but the control-plane entry point must reject effective collisions before starting.

## Smoke-test output and quota policy

EveOS inherits WatchFusion's output-efficient verification discipline.

- Use the smallest affected verification profile first after an ordinary edit:
  - `npm run --silent test:smoke` — deterministic fast profile; fingerprint-matched prior passes may be reused.
  - `npm run --silent test:deep` — broader subsystem checks when shared runtime/state/control code changed.
  - `npm run --silent test:security` — security-sensitive changes.
- `npm run verify` remains the final uncached repository gate. Run it once when the implementation is ready for final verification.
- Do not rerun an unchanged passing suite when source, tests, dependencies, configuration, and relevant environment have not changed.
- Fast-pass reuse is allowed only for the deterministic fast profile and only when the content/environment fingerprint matches exactly.
- Never reuse a cached result for deep, security, browser, integration, hardware, or final verification.
- Successful profile output should stay compact: one stable summary line is enough.
- On failure, print only bounded relevant context (fewer than 40 direct lines) and save full captured stdout/stderr under ignored `data/runtime/smoke-results/` diagnostics.
- Use verbose output only when explicitly diagnosing a failure.
- Never reduce coverage, skip a required test, suppress a meaningful warning, or weaken an assertion merely to save output/tokens.

## Agent execution efficiency

- Apply this discipline automatically regardless of selected model or reasoning effort. Preserve the user's selection; propose a change only when a concrete task warrants it.
- Prefer deterministic scripts for tests, parsing, inventories, and repeated mechanics. Background processes and subagents do not make model work quota-free.
- Batch independent reads; request only relevant file ranges and bounded output. Reuse established evidence and handoffs instead of repeating exploration.
- Let long commands run to completion; use completion-aware waits (normally 30–60 seconds), not repeated tiny polls. Do useful independent work while they run. Report meaningful progress rather than unchanged polls.
- Default to a single agent. When delegation is authorized and beneficial, assign one bounded independent responsibility with minimal context, explicit file ownership, stop conditions, and a concise evidence report. Do not delegate merely to wait on a command, recursively fan out, or duplicate the worker's review.
- Keep a compact test ledger: command, affected scope, result, relevant revision/environment, and ignored artifact location. Run the smallest affected gate, then required uncached final gates; do not reduce coverage to save tokens.
- Improve opportunistically during authorized work: record a demonstrated failure mode and a verified small technique in the existing relevant note. Consolidate rather than append repetitive history. Do not create periodic research/self-improvement jobs.
- Propose impactful workflow, architecture, model/cost, dependency, or permission changes with evidence, benefit, risk, and rollback/validation before adopting them. Routine authorized fixes continue normally.
- Commit coherent validated changes and push through the established workflow; report exact SHA and remaining uncertainty. Never commit secrets, machine-local memory, or validation-only artifacts.
- Source rationale: [official subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [usage guidance](https://learn.chatgpt.com/docs/pricing), checked 2026-09-12. These are execution practices, not a guarantee of quota savings or autonomous model learning.

## WatchFusion integration

- EveOS owns the integrated WatchFusion lifecycle/status/theme shell and exposes it as a first-class workspace beside Audioflix.
- WatchFusion's Node/WebSocket media runtime remains a separate registry-managed service (`WATCHFUSION_PORT`, currently 9087); do not hard-code its port in clients or new launchers.
- Nuvio remains an external source install; do not silently vendor or rewrite Nuvio as part of unrelated EveOS work.
- VoxelVision remains a WatchFusion capability and should not prevent the base WatchFusion service from being managed safely.
- The authoritative upstream snapshot for the initial merge is documented in `docs/WATCHFUSION-INTEGRATION.md`.
- Machine-local dependencies, sessions, downloaded media, caches, generated test results, and `node_modules` must not be committed.
- Opening WatchFusion while its runtime/control plane is stopped must remain a valid degraded mode: the workspace stays navigable and explains inactive live features instead of surfacing raw network errors.

## Browser Qualification & Verification

- Playwright is the primary authoritative automated baseline for browser qualification, UI geometry, and pointer verification.
- Camoufox is available as a secondary environment for real-world anti-bot, media, and provider behavior without committing it as a required runtime dependency.
- Test real pointer interactions (`mouse.move`, `mouse.down`, `mouse.up`, `mouse.click`) and DOM geometry rects (`getBoundingClientRect()`) rather than merely asserting DOM presence.

