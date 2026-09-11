# VoxelVision Agent Rules

## Smoke-output discipline

- Run from the subproject directory. Store generated diagnostics and test caches inside this subproject; never create them at the repository root.

- Invoke verification as `npm run --silent verify`; it must print one stable summary line when it passes.
- Do not print passing DOM, response, frame, tensor, JSON, or per-assertion dumps by default.
- On failure, print the failing stable test ID and no more than 40 lines of directly relevant context. Put complete diagnostics in the ignored `test-results/` directory.
- Detailed success output is opt-in through `npm run verify:verbose`; never enable it for a routine pass.
- Run the smallest affected smoke directly with `node scripts/<name>-smoke.mjs`. Run `npm run --silent verify` once at the final integration gate; do not repeatedly rerun unchanged passing suites.
- Prefer deterministic fixtures and summaries over screenshots or large generated artifacts unless visual verification is required.

## Module-size guardrail

- New JavaScript modules should remain at or below 450 lines. Split by responsibility before crossing that boundary.
- Existing legacy files above 450 lines are grandfathered but should not gain unrelated responsibilities. Put new subsystems behind focused facades.
