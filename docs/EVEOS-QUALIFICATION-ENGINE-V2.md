# EveOS Qualification Engine v2

## Purpose

Qualification v2 separates rapid deterministic feedback from stateful acceptance and the
canonical release gate. It does not weaken `npm run verify`: full release still executes that
command once, uncached and unchanged. Narrow profiles must report `qualificationScope=partial`
and cannot be represented as release qualification.

## Commands

| Command | Scope | Intended use |
| --- | --- | --- |
| `npm run qualify:fast:timed` | Partial | Fast deterministic development feedback. Uses the existing fingerprint-safe fast profile. |
| `npm run qualify:affected:timed -- --base <sha>` | Partial | Select registered subsystem lanes from exact changed paths. Always starts with guardrails. |
| `npm run qualify:integration:timed` | Partial | Fresh deep service/browser integration. |
| `npm run qualify:nexus:timed` | Partial plus final verify | Nexus unit checks use bounded concurrency; browser, ports and services remain serialized before canonical verify. |
| `npm run verify:timed` | Full release | Runs the canonical uncached `npm run verify` exactly once. |
| `npm run smoke:timed-qualification-contract` | Contract | Proves resource locking, nonzero failure propagation and rejection of partial results. |

`affected` records its Git base, exact files and selected subsystem classes. Unknown changes
fail toward the existing fast profile rather than producing an empty pass. AudioFlix Spotify,
shared runtime and Nexus changes select their respective registered lanes; overlapping commands
are deduplicated.

## Resource and evidence contract

Every gate declares exclusive resources such as `playwright`, `ports`, `build-output`,
`audioflix-runtime` or `nexus-runtime`. Concurrent gates acquire locks in sorted order, which
prevents deadlock and records queue wait separately from execution. Stateful service/browser
gates remain serial until repeated evidence proves a narrower ownership model.

Each run writes ignored evidence under `data/runtime/smoke-results/timed-qualification/`:

- elapsed, child-process CPU where the platform exposes it, queue wait and resource names;
- npm child-stage timing, retry/timeout mention counts and bounded failure tails;
- executed versus reused counts (dynamic results are never cached);
- critical path, lock contention, slowest checks and prior same-profile comparison;
- exact affected-file selection metadata; and
- nested quiet-suite timing, including individual AudioFlix managed-browser children.

The console prints progress heartbeats and one result line per gate. Complete stdout/stderr stays
in the ignored gate log. A failed, interrupted or partial run cannot produce `PASS`.

## AudioFlix necessity audit

Baseline on the Oct. 18 Windows checkout was 16m48s total, with 13m46s inside `verify`.
The managed and playback Spotify lanes consumed about 7m31s. Direct child profiling identified
the following high-value corrections.

The exact optimized uncached release run completed in 9m42s (582s), versus the comparable
16m48s (1008s) baseline: 7m06s faster, a 42.3% wall-time reduction. The managed Spotify stage
fell from about 272s to about 168s. The complete Spotify playback/observer stage fell from about
179s to about 15s. Its report is
`data/runtime/smoke-results/timed-qualification/verify-20261018T194254097159Z/report.json`.

| Check | Classification | Before | Decision and rationale |
| --- | --- | ---: | --- |
| Spotify playback's nested managed contract/runtime/Python/volume reruns | Duplicated | about 3 minutes | Removed from the playback leaf. Each child still runs in its authoritative registered lane later in the same release gate. |
| Queue completion contract | Necessary but inefficient | about 100s | Retained. It proves single-owner Ended/repeat/stale-run behavior. Its isolated fixture now loads every deferred script immediately instead of waiting through production idle pacing. |
| Multi-stage queue reorder contract | Necessary but inefficient | about 60s | Retained for pointer/reorder/completion races, using the same no-pause fixture mode. |
| Managed-browser contract children | Necessary, opaque | about 4.5 minutes as one block | Retained and made quiet/individually timed. Full failure output is stored in an ignored JSON artifact; success is one summary line. |
| Signed-in/live Spotify and natural-duration endurance | Expensive acceptance | External/variable | Remains explicit and fresh. It is not moved into a deterministic development profile or replaced with mocks. |
| Security, ownership, recovery and exactly-once negatives | Necessary | Variable | Retained. No assertion, permission fence or failure exit was weakened. |

## Coverage guarantees and limits

- The optimized full release still reaches every previously registered release command.
- Playback smoke is now atomic; its former children remain covered by managed, observer and
  volume lanes rather than running twice.
- `__RUSH_DEFERRED_LOAD` is test-fixture-only. It removes deliberate batch pauses but still waits
  for the loader's authoritative `completedAt` signal and executes the complete script graph.
- Quiet child execution is serial. Broader browser parallelism remains intentionally disabled
  until port/profile/service isolation is proven under repetition.
- Estimates are labeled and come only from the last successful same-profile report.
- Provider, hardware, browser-profile and lifecycle acceptance is never reused from cache.

To force exhaustive fresh qualification, run `npm run verify:timed` (or `npm run verify`).
