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

## Nuvio qualification contract

- A synthetic plugin, synthetic HLS URL, or manually injected stream may prove transport mechanics, but it must never be reported as proof that the user's real Nuvio stream discovery works.
- A `No streams found` regression is qualified only by tracing the real discovery chain: installed source state -> eligibility -> request/execution start -> result count -> Nuvio filtering -> rendered stream row. Local hardware qualification must use the user's actual configured Nuvio profile without clearing or replacing it.
- Record safe stage/timing evidence rather than credentials or full provider URLs. Never print access tokens, refresh tokens, authenticated cookies, private repository parameters, or scraper secrets.
- If real providers are unavailable in deterministic CI, use a controlled fixture only for the narrow contract it represents and keep the real-profile qualification requirement explicit and separate.
- Prefer strengthening the existing Nuvio Node/browser families before creating another smoke file. Add a new family only when no existing owner can express the regression cleanly.
- Source-tab coverage must treat Nuvio, VoxelVision, and Find Media as one lifecycle contract: opening, switching, hiding, reopening, session/state preservation, and cleanup must not regress another tab.
- For Nuvio performance regressions, measure navigation-to-metadata and discovery-to-first-stream separately so a fast shell cannot hide a stalled provider pipeline.

## Enforced output discipline

- Quiet mode is the default and emits one stable summary line on success. `--verbose` is the only opt-in path for detailed passing output.
- Failures retain nonzero exits, print stable IDs with at most 40 relevant lines each, and save bounded diagnostics under ignored `test-results/`.
- Do not rerun an unchanged passing suite. A rerun requires changed code/configuration/dependencies, an environment change, or a previously untested final integration gate.
- `test:smoke` may reuse only an identical fingerprinted fast pass. Deeper, browser, infrastructure, security, and final gates always execute normally.
- The project guardrail check validates these rules alongside the 450-line module ceiling.
