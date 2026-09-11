# WatchFusion in EveOS

WatchFusion is a first-class EveOS workspace with its own media/watch-party runtime.

## Initial upstream snapshot

The initial source merge is pinned to:

- Repository: `driftai/Private-Test-Builds`
- Path: `WatchFusion/`
- Commit: `f2f1db5b68d5529100b3ea5ee2007af144575df6`

The private source repository cannot be checked out by EveOS's ordinary GitHub Actions `GITHUB_TOKEN`, so the initial runtime hydration is intentionally performed from the user's authorized/local source checkout instead of adding a cross-repository secret.

Local authoritative source available to the verification agent:

`C:\Users\alvin\Downloads\Private-Test-Builds\WatchFusion`

Integrated destination:

`<EveOS>\tools\WatchFusion`

After the initial copy, the EveOS copy becomes the integrated working copy. Future refreshes from `Private-Test-Builds` should be deliberate source merges rather than runtime downloads.

## Ownership boundary

EveOS owns:

- Header/workspace entry beside Audioflix.
- EveOS-themed outer workspace chrome.
- Lifecycle/status integration through the local control plane on port 9082.
- WatchFusion service ownership and safety checks.
- Desired-running restore state.
- Independent headed/headless terminal preference.
- Shared smoke-test/output policy.
- Final repository verification.

WatchFusion keeps:

- Node HTTP/WebSocket server on port 9085.
- Room/host/chat/realtime synchronization.
- YouTube/direct/HLS/media provider behavior.
- Nuvio bridge/injection logic.
- VoxelVision routes and media conversion behavior.
- LAN and Cloudflare-specific runtime behavior.
- Its own focused smoke/browser/integration/security suites.

Nuvio remains a user-installed/external runtime. Do not vendor a private Nuvio installation into EveOS.

## Hydration procedure

From a current EveOS `main` checkout:

1. Copy the full contents of `C:\Users\alvin\Downloads\Private-Test-Builds\WatchFusion` into `tools\WatchFusion`.
2. Preserve the source `.gitignore` rules, especially `node_modules/`, `.runtime/`, `test-results/`, installed Nuvio content, local properties, secrets, and downloaded Cloudflare binaries.
3. Do **not** copy the source repository's `.git` metadata into `tools\WatchFusion`.
4. Run `npm ci` inside `tools\WatchFusion`.
5. Keep `node_modules` local/untracked.
6. Commit the hydrated WatchFusion source/assets required by the application, including its bundled VoxelVision source/assets that are already version-controlled upstream.

## UI integration pass after hydration

The EveOS outer WatchFusion workspace already consumes EveOS theme tokens. The embedded WatchFusion document should also be adapted so the interior feels native rather than like an unrelated site inside a frame.

Preserve WatchFusion structure and behavior while mapping its palette/components toward EveOS:

- Base background -> EveOS dark `--bg-color` / `--bg-secondary` family.
- Accent -> EveOS cyan `#00d4ff` family.
- Text -> EveOS `--text-main` / `--text-muted` equivalents.
- Borders/panels -> EveOS translucent border/card language.
- Buttons -> compact EveOS primary/secondary treatment.
- Keep media/player surfaces black where video fidelity requires it.
- Preserve responsive/mobile behavior and all existing pointer/focus fixes.

Because WatchFusion is served from port 9085, the parent EveOS page cannot reliably restyle the iframe document cross-origin. The interior theme therefore belongs in the integrated WatchFusion source itself.

## Lifecycle contract

EveOS manages WatchFusion through:

- `GET /api/watchfusion/status`
- `POST /api/watchfusion/start`
- `POST /api/watchfusion/stop`

The WatchFusion process is considered valid only when `http://127.0.0.1:9085/api/health` returns `ok: true` and `app: "WatchFusion"`.

A different process occupying 9085 is reported as blocked and must never be killed by EveOS.

Opening the WatchFusion workspace may start WatchFusion when the source and dependencies are ready. Closing the workspace does not stop the service; Stop is explicit, and EveOS global Stop also includes WatchFusion.

## Verification policy

Normal edits should use the smallest relevant profile:

- `npm run --silent test:smoke`
- `npm run --silent test:deep`
- `npm run --silent test:security`

The fast profile may reuse a prior pass only when its content/environment fingerprint is identical. Deep/security/final results are never reused.

`npm run verify` remains the final uncached gate.

`npm run smoke:watchfusion` validates the EveOS integration even before hydration. Once `tools/WatchFusion/package.json` and local dependencies exist, it automatically invokes WatchFusion's own quiet fast smoke suite. `npm run smoke:watchfusion-security` similarly invokes WatchFusion's security suite when available.
