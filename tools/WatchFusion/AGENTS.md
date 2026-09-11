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
