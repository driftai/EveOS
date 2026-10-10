# EveOS fresh install and reproducible verification

EveOS treats Git as the durable product definition and the local machine as runtime state. A clean clone must contain the source, deterministic tests, qualification drivers, setup tooling, and documentation needed to reconstruct the workspace without copying files from another EveOS installation.

## Supported base

- Windows 11 is the primary host.
- Node.js 20 or newer.
- Python 3.10 or 3.11 for the declared Python runtime dependencies.
- Git.
- Network access is required while installing npm, Python, and Playwright packages.

## Fresh clone

```powershell
git clone https://github.com/driftai/EveOS.git
cd EveOS
git switch codex/audioflix-core-stability
node tools/setup/eveos_bootstrap.mjs
```

`node tools/setup/eveos_bootstrap.mjs` is intentionally deterministic about repository dependencies: it runs `npm ci`, creates an ignored `.venv`, installs `requirements.txt` into that environment, installs Playwright Chromium, and finishes with the repository doctor. Use `node tools/setup/eveos_bootstrap.mjs --skip-browser` only when browser-backed tests will not be run on that installation.

To re-check an existing installation without changing it:

```powershell
node tools/setup/eveos_doctor.mjs
npm run test:guardrails
```

Then run the normal deterministic verification profile appropriate to the change, for example `npm test`, `npm run test:smoke`, or a focused `smoke:*` script.

## Durable tests versus private evidence

Reusable test and qualification **code belongs in Git**. Generated evidence does not.

Tracked durable tooling includes:

- `tools/smoke/` — deterministic and registered smoke entry points/helpers;
- `tools/qualification/` — opt-in machine/live acceptance drivers that need a real local environment;
- `tools/audit/` — structural, privacy, registry, and generated-asset guardrails;
- `tools/setup/` — fresh-install bootstrap and doctor.

Machine-generated evidence stays under ignored runtime locations such as `data/runtime/`, `test-results/`, logs, screenshots, traces, browser profiles, and local credentials. A qualification driver may write there, but its source must not live there.

The repository hygiene guard fails if private/runtime roots are tracked, if critical qualification drivers disappear, if package scripts point at untracked test programs, or if tracked executable source acquires a user-specific absolute home path.

## Audioflix Lane 3 live qualification

These commands are opt-in and are **not CI tests** because they use an already configured local EveOS/Spotify environment:

```powershell
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --take-over
node tools/qualification/audioflix_lane3_recovery_acceptance.mjs --take-over
node tools/qualification/audioflix_lane3_file_acceptance.mjs --take-over
```

The drivers read `config/eveos-ports.json`; they do not assume a hard-coded EveOS web port. Their generated evidence, helper state, screenshots, and browser/session data remain in ignored runtime locations.

## Privacy boundary

Never commit `.env` files, credentials, cookies, authentication profiles, local browser state, private modular state, runtime evidence, or machine-specific authorization files. The canonical examples/configuration needed to create those locally may be tracked, but the populated state remains local.

Before pushing structural work, run:

```powershell
node tools/audit/eveos_repo_hygiene_guard.mjs
npm run test:guardrails
```

The GitHub guardrail workflow uses read-only repository permissions and runs only deterministic structural checks; live provider credentials are neither required nor supplied.
