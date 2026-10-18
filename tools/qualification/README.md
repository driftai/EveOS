# EveOS qualification entrypoints

This directory contains **durable, tracked acceptance drivers**. Generated evidence belongs under ignored runtime storage (`data/runtime/smoke-results/`) and must never be copied back into Git.

## Deterministic repository gates

Run these on every development installation before live provider qualification:

```powershell
node tools/setup/eveos_doctor.mjs
node tools/setup/eveos_verify.mjs
```

`eveos_verify` composes repository hygiene, GitHub Actions security, Queue View pointer stability, recovered structural regression contracts, and the canonical deterministic guardrail suite. Live provider acceptance remains opt-in and separate.

## Codex exec bootstrap

The tracked bootstrap keeps the approval policy global, requires the exact branch and
HEAD, uses only `workspace-write`, and never retries an unknown execution outcome.
Its deterministic contract is part of `test:guardrails`:

```powershell
npm run --silent smoke:codex-exec-bootstrap-contract
```

The installed Windows CLI can be checked without model inference or mission dispatch:

```powershell
npm run --silent qualify:codex-exec-bootstrap-native
```

An actual mission launch remains explicit. Pass `--expected-head`, keep the mission and
result directory under ignored runtime evidence, and inspect the JSON receipt before any
manual retry. The bootstrap never publishes or grants TLO execution authority.

If an older workstation still contains Lane 3 `.mjs`/`.cjs` drivers under `data/runtime/smoke-results/`, audit them with:

```powershell
node tools/setup/eveos_local_hygiene.mjs
```

After pulling the tracked replacements, known promoted duplicates can be removed without deleting JSON/screenshots/log evidence:

```powershell
node tools/setup/eveos_local_hygiene.mjs --prune-promoted
```

Unknown scripts are only reported; promote or review them before deletion.

## Audioflix Lane 3 live acceptance

These tests are opt-in because they use the local managed Spotify helper and require its browser session to already be signed in. Credentials, cookies, profiles, and approval tokens are **never** repository fixtures.

### Recovery / helper restart

```powershell
node tools/qualification/audioflix_lane3_recovery_acceptance.mjs --take-over
```

Covers bounded degraded observation, helper restart with no autoplay, stale playback retirement, manual replay, and backend-state isolation.

### Canonical `file://` entrypoint

```powershell
node tools/qualification/audioflix_lane3_file_acceptance.mjs
```

Covers the canonical file entrypoint, its own visible pairing flow, backend write isolation, pointer Play Group, exact real-helper track identity, first/next-track volume, seek-assisted next-track handoff, real Stop Group resource settlement, explicit pointer replay, and reload/reset sustained idle.

### Full runtime/native matrix

```powershell
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --native --take-over --input-focus
```

Useful scoped modes are also preserved:

```powershell
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --native --take-over --http-only --input-focus
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --native --take-over --recovery-only --input-focus
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --native --take-over --repeat-probe --input-focus
node tools/qualification/audioflix_lane3_runtime_acceptance.mjs --native --take-over --volume-transition --input-focus
```

The full matrix covers real status/command/volume paths, foreground and genuinely hidden natural completion, repeat on/off, shuffle/current preservation, relay disconnect/reconnect without autoplay, helper restart recovery, HTTP reload/reset, and the file entrypoint.

## Lane 4 scoped reload acceptance

```powershell
node tools/qualification/eveos_lane4_reload_acceptance.mjs --restart
```

Run on Windows with branded Local Control and EveOS web already running in their headed default, other services idle, and the managed Spotify helper stopped. `--restart` explicitly authorizes two web replacements (HTTP and canonical file entrypoints) followed by one scoped Local Control replacement. The driver starts a fresh headed Chromium browser; `--edge` selects Edge and `--headless` is an explicit browser override.

Uses real EveOS markup/CSS, pointer Check updates, 340px toolbar bounds/hit testing, file-origin web-port discovery, fresh process/source identity, replacement ACK/readiness timing, and unchanged preferences/unrelated listener checks. Browser writes are denied except update checks and a single scoped restart request per case. It never starts/stops a child, takes over Spotify, changes browser profiles, or tears down services after a failure. Keep the managed helper stopped throughout the run; an active helper blocks preflight because web restart can restore that dependency.

Full JSON, screenshots and browser diagnostics are saved under ignored `data/runtime/smoke-results/lane4-reload-*/`. This focused gate does not certify Spotify restart, page-reload durability, other child restarts, endurance, or the complete Lane 4 matrix. `--check` validates the write policy without touching endpoints or launching a browser; the gate remains opt-in and outside deterministic `verify`.

Run this gate exclusively, after deterministic tests have finished. Its preference hashes and process identities deliberately reject concurrent lifecycle changes rather than reporting a misleading pass. A failed invariant leaves diagnostics and healthy services available for inspection; do not reset saved state to make the test pass.

Local Control's CLI `--probe` is a read-only, deadline-bounded health check. It must not import service controllers or capture source fingerprints. Full startup and explicit Check updates fingerprint tracked and non-ignored untracked runtime source, including CSS; ignored browser downloads and machine-local configuration are not update candidates. When Git is unavailable, the filesystem fallback conservatively excludes literal root-ignore paths and known cache/runtime directories. It is not a full Git wildmatch/nested-ignore interpreter; use the normal Git checkout for complete ignore semantics and explicitly tracked overrides.

Use the scoped service controls for updates, not a launcher that clears saved child preferences. A scoped Local Control replacement must preserve stopped children. Global Stop smoke fixtures must stub every production stop target before exercising that path; the ephemeral startup smokes must suppress restoration of workstation services.

## Safety and ownership

- Do not run live qualification against an active playback session you do not intend to take over.
- `--take-over` is explicit; omit it when takeover is not intended.
- Qualification creates disposable in-page library fixtures and verifies canonical backend Audioflix state is unchanged.
- Native qualification uses a temporary browser profile. It does not copy or commit the signed-in managed helper profile.
- Ports come from `config/eveos-ports.json`; do not hard-code workstation paths or PIDs.
- Keep reusable qualification code here or in `tools/smoke/` / `tests/`. Keep only generated evidence in `data/runtime/`.

Normal updates should arrive through Git:

```powershell
git pull --ff-only
```

Do not maintain separate downloadable replacement copies of these drivers.

## Mandatory local publication checks (V0.7.5)

Enable the tracked Git hooks once per checkout with `npm run hooks:install`. The
pre-commit hook rejects files over 450 lines and growth beyond the 440-line
headroom gate, alongside existing credential, runtime-asset and extension checks.
The pre-push hook permits only one clean fast-forward update of
`eve/nexus-machine-spaces` to a matching fetched origin SHA, then executes
`npm run test:guardrails` against the exact candidate commit. A failing test
or changing source blocks publication. Use `git fetch origin` and inspect
remote drift rather than bypassing the hook. `main` remains protected.

Git hooks are local and can be bypassed by `--no-verify`, a different Git
installation/configuration, or direct GitHub API writes. They do **not** replace
server-side branch rules and required CI checks. A future remote enforcement
step must be explicitly configured before claims of unbypassable publication.
