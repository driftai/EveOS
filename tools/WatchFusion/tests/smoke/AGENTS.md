# WatchFusion smoke policy

Use the smallest test profile that proves the change.

## Default after ordinary edits

`npm run --silent test:smoke`

This runs the deterministic local smoke contract only. It checks the core source-tab DOM contract, source-switch wiring, app.js bundling, and basic health/static serving. It does not use live media services, Cloudflare, YouTube, or Playwright.

## When a deeper server-side change was made

`npm run --silent test:deep`

This runs the existing Node smoke matrix plus the security suite. It is intentionally slower and should be used when backend behavior, room state, providers, realtime behavior, or Nuvio server routes changed.

## Browser/UI changes

`npm run --silent test:browser`

Use this for DOM interaction, rendering, iframe visibility, pointer/click behavior, or other browser-only behavior. Prefer a targeted Playwright spec during development rather than the entire browser suite when possible.

## Live/infrastructure checks

`npm run --silent test:integration`

Use this only when LAN, Cloudflare, or live YouTube behavior is part of the change.

`npm run --silent test:security`

Use this for security-only changes.

## Full validation

`npm run --silent test`

This is the expensive catch-all profile and runs the complete Node, security, integration, and browser validation. It is for release/final verification, not the default agent loop.

## Enforced output discipline

- Quiet mode is the default and emits one stable summary line on success. `--verbose` is the only opt-in path for detailed passing output.
- Failures retain nonzero exits, print stable IDs with at most 40 relevant lines each, and save bounded diagnostics under ignored `test-results/`.
- Do not rerun an unchanged passing suite. A rerun requires changed code/configuration/dependencies, an environment change, or a previously untested final integration gate.
- `test:smoke` may reuse only an identical fingerprinted fast pass. Deeper, browser, infrastructure, security, and final gates always execute normally.
- The project guardrail check validates these rules alongside the 450-line module ceiling.
