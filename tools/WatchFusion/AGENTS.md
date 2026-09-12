# WatchFusion Project Rules

## Module-size guardrail

- Keep new JavaScript modules at or below 450 lines.
- Split by responsibility before crossing the limit; do not grow grandfathered legacy modules with unrelated work.

## Smoke-output guardrail

- Treat smoke-output efficiency as an enforced project invariant, equal to the 450-line module rule.
- Run the smallest affected profile first with `npm run --silent test:smoke`, `test:deep`, `test:browser`, `test:integration`, or `test:security`.
- Run `npm run --silent test` once at the final integration gate. Do not rerun an unchanged passing suite without a new code, configuration, dependency, or environment reason.
- The fast profile may reuse a prior pass only when its source/test and Node-environment fingerprint is identical. Never reuse full, browser, integration, security, or final-release verification.
- Successful non-verbose verification must print one stable summary line. Passing assertions, DOM, responses, frames, JSON, and subprocess chatter stay suppressed.
- A failure must retain a nonzero exit code, identify stable failing IDs, and print no more than 40 relevant lines per failure.
- Store complete bounded diagnostics under ignored `test-results/`. Detailed passing output is allowed only through an explicit verbose command.
- Never reduce coverage, hide actionable warnings, or treat cached/old results as a final verification pass merely to save output.

## External Nuvio integration boundary

- Treat the installed Nuvio application under `tools/WatchFusion/nuvio` as external user-side software, not as first-party WatchFusion source.
- Integrate through wrapper-owned connectors: generated runtime environment, WatchFusion HTTP/proxy routes, same-origin iframe/runtime injection, and narrowly scoped response adaptation at the WatchFusion boundary.
- Do not add new persistent rewrites of upstream Nuvio core modules to fix WatchFusion behavior. Existing source-patch scripts are migration debt: when work touches them, prefer moving the behavior into wrapper-owned injection/connectors and reducing the patch surface rather than expanding it.
- Never commit, replace, reset, or clear the user's installed Nuvio source, build output, profile, storage, or authentication state as part of normal WatchFusion development.
- Preserve the canonical host-side Nuvio origin (`http://127.0.0.1:9087/...`) so login/storage identity is stable across EveOS, WatchFusion, and Nuvio.
- Keep host-capability bridges host-local. A Cloudflare/LAN transport is not authorization for local plugin networking, filesystem controls, diagnostics, or credentials.
- Use `https://github.com/driftai/Side-Builds/tree/main/Nuvio-Onion-Wrapper` as the architectural reference for the external-install/wrapper boundary when Nuvio integration behavior is ambiguous.
- Optimize Nuvio boot/reopen work at the wrapper lifecycle boundary first (iframe reuse, bounded readiness, caching, request fan-out) before changing upstream Nuvio internals.
