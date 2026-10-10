# EveOS fresh clone and reconstruction

This document is the tracked reconstruction contract for EveOS. A clean Git clone must contain the durable code, setup tooling, deterministic tests, smoke/qualification entrypoints, and repository checks needed to rebuild a development installation without copying files from an older workstation.

Machine-local user data, credentials, signed-in browser profiles, runtime databases, logs, screenshots, traces, test evidence, caches, virtual environments, and installed dependencies are intentionally **not** stored in Git.

## Prerequisites

- Git
- Node.js 20 or newer
- Python 3.10 or 3.11
- Windows for the primary full EveOS launcher (`start-server.bat`)

The canonical service/port assignments are tracked in `config/eveos-ports.json`. Do not hard-code a workstation-specific EveOS path into tracked code or tests.

## Clean installation

From PowerShell:

```powershell
git clone https://github.com/driftai/EveOS.git
cd EveOS
node tools/setup/eveos_bootstrap.mjs
```

The bootstrap performs the locked Node install, creates an isolated `.venv`, installs runtime and test Python requirements, installs the Playwright Chromium runtime unless explicitly skipped, and finishes by running the repository doctor.

For CI or a development machine where browser-dependent qualification is intentionally unavailable:

```powershell
node tools/setup/eveos_bootstrap.mjs --skip-browser
```

`--skip-browser` is not equivalent to a fully browser-qualified installation; it only skips installation/validation of the managed browser runtime.

## Verify an installation

Run the doctor whenever a clone is moved, reconstructed, or materially updated:

```powershell
node tools/setup/eveos_doctor.mjs
```

Run the canonical deterministic repository proof before treating a branch as clean:

```powershell
node tools/setup/eveos_verify.mjs
```

That aggregate runs the repository privacy/runtime hygiene guard, the Queue View pointer-stability regression, and the existing deterministic guardrail suite through the project virtualenv.

Generated asset references are repository state. To verify them:

```powershell
node tools/setup/eveos_npm.mjs run build:asset-versions
git diff --exit-code -- EveOS.html js/config/manifest
```

A non-empty asset-version diff means the generated references need to be reviewed and committed with the source change that caused them.

## Run EveOS on Windows

```powershell
.\start-server.bat
```

With the default tracked port configuration, the main HTTP entry is:

```text
http://127.0.0.1:8765/EveOS.html
```

Use `config/eveos-ports.json` as the source of truth if the tracked port map changes.

## Durable tests versus runtime evidence

Reusable test logic belongs in tracked locations such as:

- `tests/`
- `tools/smoke/`
- `tools/qualification/`
- `tools/audit/`
- `tools/setup/`

Do **not** place a reusable test driver only under `data/runtime/`, `logs/`, `output/`, or `test-results/`. Those locations are intentionally ignored because they hold machine-local/generated state.

Audioflix Lane 3 live qualification entrypoints are tracked under `tools/qualification/`. They may require an already signed-in local browser/provider session. Authentication material is never part of the repository. Their generated evidence belongs under ignored runtime storage such as `data/runtime/smoke-results/`.

## Privacy and repository hygiene contract

The repository hygiene guard must remain part of deterministic qualification. It protects the fresh-clone contract by rejecting tracked runtime/private roots and workstation-specific absolute paths in executable/tooling surfaces.

Never commit:

- passwords, API tokens, cookies, session credentials, or browser profiles
- personal media/library databases or user-specific World Book/Piano/runtime state
- logs, screenshots, traces, test evidence, caches, or temporary outputs
- `.venv`, `node_modules`, Python caches, or pytest caches
- reusable qualification code only in an ignored runtime directory

When a new reusable smoke, diagnostic, fixture, or qualification capability becomes important to acceptance, promote it into a tracked test/tool location and register it with the repository's existing guardrails rather than relying on a workstation copy.

## Updating an existing clone

Normal code updates should flow through Git instead of downloaded replacement files:

```powershell
git pull --ff-only
node tools/setup/eveos_doctor.mjs
node tools/setup/eveos_verify.mjs
```

If dependency lockfiles, Python requirements, browser tooling, or setup contracts changed, rerun the bootstrap:

```powershell
node tools/setup/eveos_bootstrap.mjs
```

The repository, not an individual workstation directory or chat transcript, is the durable source of truth for reconstructing EveOS.
