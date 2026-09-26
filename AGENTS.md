## Dex coordination: budget and transcript discipline

Dex envelopes expose physical turn counters. A budget-complete stop is NOT a task-complete DONE. Do not dump entire room histories into every relay; default is last prior message per exact room agent, plus the current full source. Attach `[[DEX:CONTEXT:N]]` only when this specific handoff needs more context, or privately query `[[DEX:CMD {"action":"room_log","limit":10}]]` with exact room authorization and a cursor. For an in-flight reply nearing exhaustion use `[[DEX:BUDGET:+N]]` (max 500 allocated per run); final scheduled recipients receive a capacity-aware nudge in their EXISTING turn to choose an extension BEFORE RETURN, not a new round-trip or automatic continuation. Omission means budget stop, not DONE. Query or change an idle room via `room_budget` / `set_room_budget`. Provider CMD pauses its current relay; idle budget replacement can request `resume:true`. Never fabricate a delivery receipt, replay an uncertain turn, or confuse remote simulations with native/local headed proof.

## Dex new-message admission and unfinished work

An intermediate status or `[[DEX:NOTE]]` does not imply Astro's terminal task is complete. When the terminal still has nonzero `/tasks`, preserve the original request and keep capturing rather than declaring a final reply. If detached qualification must outlive the relay, explicitly register its exact room/member/branch/SHA with the signed task-completion runner before ending the room. Authenticated new reports may instead be sent to the exact room while another turn is active; localhost queues them durably, returns `queued` (not `delivered`), and batches them FIFO at the next safe hop. Never treat an out-of-band SEND's already committed request-ID receipt as grounds to arm a second pending control receipt after the originating turn finalizes. A stopped relay plus an admitted inbox is not a clean global idle gate for deployment or chat deletion.

# EveOS Agent Rules

These rules apply to development and verification across EveOS.

## Architecture

- Keep first-party source modules at or below 450 physical lines. Split by responsibility instead of hiding logic in generated blobs.
- Preserve domain boundaries. EveOS may own lifecycle, status, state, theme, and shared contracts while specialized tools keep their own runtimes when that isolation is useful.
- Never kill a local process merely because it owns an expected port. Verify the service identity first.
- After a server-side change, restart the verified EveOS-owned process before claiming a live browser test covers the new code; record its new start time/health. Refreshing Matrix or EveOS cannot reload an already-running Python control plane. Use its managed lifecycle when available and inspect launchers for unrelated state changes.
- Treat `main` as the canonical development line unless the user explicitly asks for a branch.
- `config/eveos-ports.json` is the single source of truth for EveOS-owned service ports. New services must register an environment key, label, and unique port there instead of introducing a new literal port in a launcher or lifecycle controller.
- Environment port overrides are allowed for qualification/debugging, but the control-plane entry point must reject effective collisions before starting.

## Branch hygiene and exact-state qualification

- Default to `main` plus **one** active development/qualification branch. An additional temporary branch must have a named purpose and a cleanup checkpoint; do not accumulate abandoned qualification branches.
- Keep the current, locally qualified rollback branch until the replacement has completed the **exact-head** local Nexus suite, root structural/AI gates, supervised deployment and doctor checks. A newer unqualified feature branch is not a substitute for that rollback.
- Before removing an old local or remote branch: fetch and record its exact head; prove `git merge-base --is-ancestor <old-SHA> <current-SHA>`; check no unmerged commits, open PRs, local worktrees or live deployment depend on it; preserve its rollback SHA in the handoff. Confirm the selected branch is not checked out and that the current branch/working tree are clean. If the deletion capability is unavailable, provide the exact manual command and mark cleanup **pending**, not completed.
- Never force-push or delete `main`, a currently deployed revision, a diverged branch, or another agent's unexplained work. Do not rewrite production deployment history to create the appearance of a two-branch repository.
- The Eve-first/Astro-second handoff must include exact source branch/SHA, qualified branch/SHA, new work's tests, all eight locally durable Dex room idle/recovery checks, deployment restraint and the **next safe cleanup step**. One-shot detached qualification results return to the requesting agent through the authenticated completion journal without creating another relay turn. A submitted notification is not proof that the ChatGPT model read it.
- Durable workflow pointers: ChatGPT Library `/Projects/Eve OS/EVE-DEV-WORKFLOW.md` and `/Eve/Context-Packs/File-Manager-Cleanup-Workflow.md` (the canonical Library path may include a different displayed prefix; locate by document identity, not by guessing a path).

## Smoke-test output and quota policy

EveOS inherits WatchFusion's output-efficient verification discipline.

- `npm run --silent test:guardrails` is the structural preflight after every coherent code/test batch and before stacking another qualification batch. It proves runtime asset hashes are already synchronized, the smoke registry has zero backlog, the coverage sensor remains at 100%, changed files have line-count headroom, and the 450-line hard cap still holds.
- The smoke registry is a zero-backlog invariant. `tools/audit/smoke-registry-baseline.json` must remain empty; credential-dependent or hardware/live probes still need explicit opt-in npm registration rather than baseline exemptions.
- Changed first-party files may not grow past the 440-line headroom guard even though the repository hard cap is 450 lines. Existing near-cap files may remain untouched, but changed responsibilities must split before they hit the hard wall.
- Every deterministic smoke profile starts with `test:guardrails`. Focused `test:handoff -- --script ... --profile none` runs also prepend it automatically, so a narrow subsystem pass cannot hide stale assets, dormant smokes, or file-size debt.
- Final `verify` runs structural guardrails before any asset synchronization/build writer. A stale generated asset reference is a source-state failure to commit explicitly, not something final verification should silently repair.
- Use the smallest affected verification profile first after an ordinary edit:
  - `npm run --silent test:smoke` — deterministic fast profile; fingerprint-matched prior passes may be reused.
  - `npm run --silent test:deep` — broader subsystem checks when shared runtime/state/control code changed.
  - `npm run --silent test:security` — security-sensitive changes.
  - `npm run --silent test:ai-control` — Search Monitor, Agent Nexus, TLO/Local MoE, and Nexus Browser changes, including the focused browser lane.
- `npm run verify` remains the final uncached repository gate. Run it once when the implementation is ready for final verification.
- Do not rerun an unchanged passing suite when source, tests, dependencies, configuration, and relevant environment have not changed.
- Fast-pass reuse is allowed only for the deterministic fast profile and only when the content/environment fingerprint matches exactly.
- Never reuse a cached result for deep, security, browser, integration, hardware, or final verification.
- For multi-edit bug fixes, establish the failure with one focused diagnostic or red regression, finish the coherent correction, then run the affected smoke profile. Do not rerun smoke suites after each tentative edit; run final `verify` once after the fix settles, and again only if later edits invalidate it.
- During active human-reviewed visual tuning, batch the related screenshot-driven corrections and defer smoke suites when the user asks to hold them. Continue with bounded inspection, asset synchronization, and proven patch mechanics; after the user clears the settled behavior, run the smallest affected smoke once and the required final gate once. This schedules verification rather than weakening or skipping it.
- Successful profile output should stay compact: one stable summary line is enough.
- On failure, print only bounded relevant context (fewer than 40 direct lines) and save full captured stdout/stderr under ignored `data/runtime/smoke-results/` diagnostics.
- Use verbose output only when explicitly diagnosing a failure.
- For chat-driven/manual qualification, prefer `npm run test:handoff -- --base <sha> --script <focused-script> --profile <none|fast|deep|security|ai-control>`. Use `ai-control` for Search Monitor/Agent Nexus/TLO/Nexus Browser work. Add `--final` only when the uncached full `verify` gate is warranted.
- The handoff runner is the normal human-operator evidence path: it records exact HEAD/origin alignment, worktree state, changed files, Node/Python/Playwright identity, registered-port listeners, per-command duration, bounded failure context, and ignored full JSON/log artifacts under `data/runtime/smoke-results/`.
- Do not require Nova/Astro merely to collect routine test evidence that the handoff runner can produce. Reserve local agents for diagnosis or repair that actually needs browser/computer-use/hardware judgment.
- The handoff runner refuses a dirty worktree by default. Use `--allow-dirty` only when the dirty state is deliberate and report it explicitly.
- Search Monitor live runtime qualification is explicit only: use `npm run runtime:search-monitor:qualify` when real localhost/process/model/browser state must be proven. Never add the live gate to normal `verify` or deterministic smoke profiles.
- Search Monitor status surfaces must converge after transient failures: Local MoE, TLO, and Nexus Browser should re-check from the existing control-plane heartbeat while Workspace is active, and live browser qualification must cover both localhost and the normal file:// EveOS entrypoint.
- Lifecycle-backed EveOS tools/plugins must keep a passive, side-effect-free status contract and remain covered by `smoke:capability-surfaces`. That lane also runs the synthetic capability transition matrix so stopped/starting/blocked-or-conflict/running/setup-degraded states stay representable without launching real services. New lifecycle services must expose coherent state/readiness/ownership/setup signals and canonical registry-backed ports; new embedded server capabilities must add route/module coverage instead of existing only as unreachable smoke files.
- Treat `LAST-EVEOS-CAPABILITY-STATE.json`, `LAST-EVEOS-CAPABILITY-MATRIX.json`, and `LAST-EVEOS-SMOKE-COVERAGE.json` as the system-level smoke sensors. The first reports current passive state, the second proves alternate lifecycle states, and the third exposes registered-versus-backlog coverage by subsystem; new tools/plugins should extend these sensors instead of adding isolated unobserved tests.
- Live Search Monitor smoke failures must be self-contained in the invoking terminal: capture bounded relevant log tails and a runtime snapshot first, then stop only the attributable session-owned component when that attribution is clear. Generation failures stop the managed model child while leaving the Harness up; browser/UI failures preserve healthy servers rather than guessing.
- Managed EveOS service consoles and managed child runtimes are headed by default. Hidden/headless execution is an explicit override only; runtime qualification must actively restore the default and each participating service to headed before launch. Local Control itself must open in a normal visible terminal, not minimized. Local MoE's Windows model runtime must expose a dedicated headed FreeToken/Prism log console by default while the engine keeps the proven direct diagnostic-log capture path.
- Live runtime qualification must leave its headed service terminals running after success or failure so chat/manual diagnosis can inspect the exact runtime state. Teardown is a separate explicit `runtime:search-monitor:stop` or `runtime:search-monitor:restart` action.
- Normal Search Monitor runtime stop may stop only services recorded as started by that runtime session. `--all` is the explicit override; underlying controllers still verify branded identity/ownership and must never kill by port alone.
- Preserve `LAST-SEARCH-MONITOR-RUNTIME.json` and browser/runtime diagnostics on live failures; do not clean them up before evidence is collected unless continued execution is unsafe or resource pressure requires it.
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
- High-value AI-control browser smokes should write ignored failure evidence under `data/runtime/smoke-results/` (screenshot, DOM snapshot, trace, and console/page/request diagnostics) so a human terminal operator can hand sufficient evidence back to chat without a local diagnostic agent.
- Camoufox is available as a secondary environment for real-world anti-bot, media, and provider behavior without committing it as a required runtime dependency.
- Test real pointer interactions (`mouse.move`, `mouse.down`, `mouse.up`, `mouse.click`) and DOM geometry rects (`getBoundingClientRect()`) rather than merely asserting DOM presence.

