# Timed qualification and safe concurrency (v0.7.1B)

This checkpoint makes EveOS qualification observable and modestly faster without modifying or skipping the canonical `npm run verify` suite.

## Commands

- `npm run verify:timed` executes the original, complete `npm run verify` once. It emits `VERIFY_STEP` banners and a fifteen-second `IN_PROGRESS` heartbeat with wall-clock elapsed time.
- `npm run qualify:nexus:timed` runs five independent, pure Node unit/syntax gates with **at most three worker processes**, then Playwright, Nexus, Machine Spaces, AI-control, security, and the **entire original verify** serially. A non-green unit gate prevents any stateful gates from starting.
- To reduce worker contention, use `python -B tools/qualification/eveos_timed_qualification.py --profile nexus --jobs 1` or `--jobs 2`.

Outputs and per-gate logs are retained in ignored `data/runtime/smoke-results/timed-qualification/<profile>-<timestamp>/`, including `report.json` with total and per-gate durations. Individual npm banners inside verify are **observed timestamps**, not independent test outcomes; nested scripts can appear as substeps. The original verify's exit code alone determines its PASS/FAIL. Timers are wall-clock and historical baselines are not treated as an ETA before measurement.

## Hard constraints

1. **No bypass or cache for full verification**. The underlying npm verify command runs unchanged; none of its smoke tests are omitted or reordered.
2. Only test-only Node invocations and `node --check` run concurrently. No browsers, services, ports, data migrations, builds, repository writes, or Git publication overlap by this runner.
3. The runner **never publishes** or calls Git mutation commands. Future ZIP publishers must retain pinned Git baseline, exact paths, canonical hooks, guarded commit, ordinary push, and remote readback independently.
4. Failures and slow gates are visible in the original per-gate logs. A slow warning does not automatically kill tests that may own nested service processes. The user can investigate or interrupt safely.
5. This is the **instrumentation phase**, not a claim of a large speedup. Once timing reports identify true bottlenecks, introduce separate service/port namespaces and explicit isolation tests before enabling deeper parallelism.

Current live Nexus TUI commit baseline: `244b46b0324972a503b144260bca47e0d2ea02a9`. The timed runner requires a fresh local qualification and cannot retroactively time the already published run.
