# EveOS fresh install and reproducible verification

EveOS treats Git as the durable product definition and the local machine as runtime state. A clean clone must contain the source, deterministic tests, qualification drivers, setup tooling, and documentation needed to reconstruct the workspace without copying files from another EveOS installation.

## Supported base

- Windows 11 is the primary host.
- Node.js 20 or newer.
- Python 3.10 or 3.11.
- Git.
- Network access is required while installing npm, Python, and Playwright packages.

## Fresh clone

```powershell
git clone https://github.com/driftai/EveOS.git
cd EveOS
git switch codex/audioflix-core-stability
node tools/setup/eveos_bootstrap.mjs
```

The default bootstrap is the development/test install. It runs `npm ci`, creates the ignored project `.venv`, installs `requirements-dev.txt` (which includes the runtime requirements plus the Python test runner), installs Playwright Chromium, and finishes with the repository doctor.

Optional bootstrap modes:

```powershell
# Runtime only; do not install Python test dependencies.
node tools/setup/eveos_bootstrap.mjs --runtime-only

# Keep the development/test environment but skip the Playwright browser download.
node tools/setup/eveos_bootstrap.mjs --skip-browser
```

The doctor understands the same flags, so an intentionally browser-free or runtime-only installation is not reported as corrupt.

## Run repository commands in the EveOS Python environment

Many historical npm scripts invoke `python` directly. Do not depend on the machine-wide Python environment. The portable wrapper places the project `.venv` first in `PATH` and exports the same interpreter through `PYTHON` / `EVEOS_PYTHON` for child processes:

```powershell
node tools/setup/eveos_npm.mjs run test:guardrails
node tools/setup/eveos_npm.mjs run test:smoke
node tools/setup/eveos_npm.mjs run smoke:audioflix-playback
```

Existing plain `npm run ...` commands remain valid when the project virtual environment is already activated, but the wrapper is the reproducible fresh-clone path.

To re-check an installation without changing it, use the canonical aggregate:

```powershell
node tools/setup/eveos_doctor.mjs
node tools/setup/eveos_verify.mjs
```

`eveos_verify` protects repository privacy/runtime boundaries, the Queue View pointer-stability regression, and the existing deterministic guardrail suite in one tracked command.

## Durable tests versus private evidence

Reusable test and qualification **code belongs in Git**. Generated evidence does not.

Tracked durable tooling includes:

- `tools/smoke/` — deterministic and registered smoke entry points/helpers;
- `tools/qualification/` — opt-in machine/live acceptance drivers that need a real local environment;
- `tools/audit/` — structural, privacy, registry, and generated-asset guardrails;
- `tools/setup/` — fresh-install bootstrap, environment wrapper, Python resolver, doctor, and aggregate verifier;
- `tests/` — deterministic contract/regression tests.

Machine-generated evidence stays under ignored runtime locations such as `data/runtime/`, `test-results/`, logs, screenshots, traces, browser profiles, caches, and local credentials. A qualification driver may write evidence there, but its source must not live there.

The repository hygiene guard fails if private/runtime roots are tracked, if critical qualification/setup capabilities disappear, if package scripts point at untracked programs, or if tracked executable source acquires a user-specific absolute home path.

## Audioflix Lane 3 live qualification

These commands are opt-in and are **not CI tests** because they use an already configured local EveOS/Spotify environment:

```powershell
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --take-over
node tools/qualification/audioflix_lane3_recovery_acceptance.mjs --take-over
node tools/qualification/audioflix_lane3_file_acceptance.mjs --take-over
```

The drivers read `config/eveos-ports.json`; they do not assume a hard-coded EveOS web port. Their generated evidence, helper state, screenshots, and browser/session data remain in ignored runtime locations.

## Privacy boundary

Never commit `.env` files, credentials, cookies, authentication profiles, local browser state, private modular state, runtime evidence, machine-specific authorization files, caches, or local virtual environments. Canonical examples/configuration needed to create those locally may be tracked, but populated state remains local.

Before pushing structural work, run:

```powershell
node tools/setup/eveos_verify.mjs
```

The GitHub guardrail workflow has repository read permission only, uses pinned action SHAs, supplies no provider secrets, and separates zero-install structural checks from the Windows fresh-install proof.
