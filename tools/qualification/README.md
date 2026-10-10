# EveOS qualification entrypoints

This directory contains **durable, tracked acceptance drivers**. Generated evidence belongs under ignored runtime storage (`data/runtime/smoke-results/`) and must never be copied back into Git.

## Deterministic repository gates

Run these on every development installation before live provider qualification:

```powershell
node tools/setup/eveos_doctor.mjs
node tools/setup/eveos_verify.mjs
```

`eveos_verify` composes repository hygiene, Queue View pointer stability, and the canonical deterministic guardrail suite. Live provider acceptance remains opt-in and separate.

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
