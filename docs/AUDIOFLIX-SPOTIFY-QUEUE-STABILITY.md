# Managed Spotify queue stability

This correction starts from `9b20e756b0920cc1af36477145f147b6e93503c8` on
`codex/audioflix-core-stability`. It addresses the reported Windows live queue skips;
it is not a claim that the entire stability/repository-health roadmap is complete.

## Reproduced causes and contracts

- A first controller already loads the URI supplied to `createController`; loading it
  again needlessly navigated/replaced the iframe during startup.
- Same-URI queue slots need a fresh playback generation, not another iframe navigation.
  Native reset-to-zero can arrive before the new Play request. It must not unlock
  replay completion: a late final frame otherwise ends the new queue slot.
- SDK/Pause-button state is not sufficient proof of playback when instrumented media
  is present and paused. Startup recovery must require current-generation media evidence.
- A fenced replay can remain `starting` at zero rather than `provider-paused`.
  It gets one bounded trusted Play activation, not indefinite clicks or an established
  provider-pause watchdog. Explicit Pause clears play intent, including after later
  provider acknowledgements. New input rechecks the generation and play intent.
- Managed music seeking uses the already instrumented media element, clamps to its
  actual available duration, and acknowledges the exact generation/track. It never
  sends a competing SDK seek or reports a fake successful seek on unavailable media.

Audioflix's existing queue/completion owner remains authoritative. No extension,
Windows-volume suppression, provider-owned queue/repeat setting, entitlement bypass,
or second queue scheduler is introduced.

## Qualification and test isolation

- `audioflix_spotify_engine_smoke.js` reproduces the reset-before-Play/final-frame race.
- `audioflix_spotify_strong_confirmation_smoke.js` covers replay startup recovery,
  trusted pointer input, wrong-generation rejection, explicit Pause and native seek.
- Runtime hook and playback smokes retain volume, queue reorder, repeat-rearm,
  reload, localhost/file entrypoint, and superseded-start checks.
- `audioflix_spotify_live_isolation_smoke.js` exercises real state/recovery/modular
  persistence modules behind a browser-context write barrier.
- The opt-in long-queue live smoke denies backend persistence writes before navigation,
  keeps playback RPCs available, blocks service workers, proves a harmless write denial,
  then checks that canonical backend Audioflix state is unchanged after disposal.
  Replacing `saveConfig` or restoring an old snapshot is not test isolation.
- A seek-to-tail live pass is transition stress, not full-duration endurance.
  `--allow-visible-controller` does not prove hidden/background operation.
  Deterministic file tests do not prove Spotify service/account behavior on file://.

## Remaining qualification boundaries

Windows live transition stress passed 20/20 with the saved signed-in Edge profile:
one URI reused across twenty distinct queue entries, no skips, final queue completion,
and identical canonical backend Audioflix digests before/after (60 real tracks).
A second localhost run passed 8/8 while alternating two actual Spotify URIs,
again with zero queue skips and unchanged canonical library state.
The seek-to-tail completion measurement had a 3.069s median and 3.612s maximum;
the separate queue between-song diagnostic had a 3.388s median and 14.998s maximum.
Hidden-controller proof was false, so background/full-duration qualification remains open.
A fresh file-origin controller requires the normal one-time control approval; failure
before that approval is not provider playback proof and must not be bypassed silently.

The final deterministic Spotify profile passed all nine registered lanes. Uncached
`npm run verify` passed the earlier structural/security preflights but stopped at
Nexus Browser: 1,632/1,644 tests passed, with these twelve pre-existing failures:

| Test file under `tools/Nexus-Browser/tests/` | Failing test declaration lines |
| --- | --- |
| `dex-done-watch.test.js` | 118 |
| `dex-interrupted-room-routing.test.js` | 34, 45 |
| `dex-provider-control-entry-check.test.js` | 20 |
| `dex-provider-control-routing-timeout.test.js` | 21, 64 |
| `dex-provider-control-routing.test.js` | 115, 156, 244, 271, 325, 361 |

The failure log is ignored at `data/runtime/smoke-results/nexus-browser-failure.log`.
These unchanged test/production files were already red at the starting checkpoint.
Two other stale intent fixtures and the extracted Search Monitor/playback source
fixtures were corrected without altering production authorization or assertions.

- Collect current live results and exact commit SHA in the operator handoff. Do not
  promote this branch into Machine Spaces/main or delete the qualified rollback branch
  merely because deterministic smokes pass.
- Resolved (lifecycle lease): every Play/Resume start and managed media seek in the helper
  runs under one `audioflix_spotify_playback_lease.js` lease (15.5s start budget inside the
  18s private RPC, 6s seek budget). Observation polls, hovers, scans, retoggles, the bounded
  resume, trusted reactivation, volume reapply and seek acknowledgement are all bounded by it.
  Pause/Stop/load/play/resume/restart transport requests, `/open` page resets and helper
  shutdown cancel outstanding leases. Generation, track and play intent are rechecked
  immediately before each delayed click/resume/acknowledgement. Aborts return structured
  `lifecycle` (`deadline|superseded|paused|stopped|page-reset`) with `deadlineExpired` or
  `superseded`, never the RPC socket `timeout` bit, so the client does not adopt a settled
  start. An expired start withdraws only its own still-requested generation with a bounded
  engine pause. Strong media-based confirmation is unchanged.
  `audioflix_spotify_playback_lease_smoke.js` covers deadline, supersession between control
  read and click, explicit Pause, happy path, hung/stale seek and reactivation cancellation.
- Browser mutations consume the parent lease (`lease.mutate`): each Play click, forced click,
  dispatched fallback, same-generation resume and trusted reactivation click is fenced before,
  given a timeout of at most the lease's remaining time (and reactivation's own 3.2s budget),
  and refenced after. A timed-out forced click rechecks the lease before its dispatch fallback,
  so no click can land after the deadline or a cancellation. The lease smoke reproduces the
  late visible click, late `dispatchEvent` and parent-expired reactivation; all three fail on
  `d9f6cdab` and pass now.
- Queue run versus engine generation (closed by control-plane preemption): `playbackRunId`
  stays Audioflix's queue authority, `_track_generation` the engine-track identity and
  `clientCommandSeq` broker command order. After a playback intent (play/resume/restart ->
  superseded, pause -> paused, stop -> stopped) passes authentication, connection, `commandId`
  and sequence acceptance, and only when the owner rules allow it, the broker records it as the
  newest accepted intent `(clientId, clientCommandSeq)`. If transport work is already holding
  `_transport_lock`, it sends one bounded (2.5s) interrupt to the helper's fixed, token-protected
  `/transport-interrupt` *before* waiting on `_transport_lock`, without taking `manager._lock`.
  When a queued intent finally gets the lock, it does no browser work unless it is still the
  newest accepted intent, and returns a structural `superseded` result. The helper's interrupt
  bumps an internal preemption epoch (captured by every play/resume before its first awaited
  engine call, and checked by its lease), so a start invalidated before its lease existed cannot
  continue. Pause/Stop with a start in flight quiesce the current generation immediately.
  Every abandoned start quiesces only its own still-current generation (an engine-side
  synchronous generation check), so it never pauses a newer one. Ordinary transport stays
  serialized. any-browser now sends Pause/Stop/switch-away while a remote start is in flight,
  and treats a preempted start as superseded (no queue skip). Coverage:
  `audioflix_spotify_preemption_smoke.py` (stale queued fence, A->B, Stop, observer cannot
  interrupt, dead or hung helper) and `audioflix_spotify_preemption_helper_smoke.js` (lease
  and pre-lease interrupt, A->B, audible Stop, real helper token check). Pause/Stop latency
  during a slow start is now bounded by the interrupt instead of the 15.5s lease.
- First managed-engine launch (checkpoint 1d): Play acquires ownership only after
  `_start_engine()` (up to the 135s launch budget), so while no owner exists, the initiating
  client's own Pause/Stop may preempt its pending Play. This holds only while transport is busy
  and both the running and the latest accepted intents are that client's; observers never can.
  After `_start_engine()` returns, Play re-checks `still_current_locked()` before owner
  acquisition, the generation bump, Load, volume and Play, and returns the structural superseded
  result if a newer intent won. The broker fence is authoritative; the helper interrupt is
  best-effort while the helper is still launching. Boundary: browser-process launch itself is
  not cancellable, so a cancelled first launch still finishes starting the (silent) engine.
  any-browser clears `starting` per run, and a superseded run's late failure resolves false.
- Load -> Play handoff (checkpoint 1e): the initial Play's Load -> volume -> Play runs in
  `load_volume_play()`, which re-checks the accepted intent after Load and after volume, the
  authoritative fallback when the helper interrupt is unavailable. The helper captures
  `preemptEpoch` before Load's awaited work and returns it. The broker sends that fixed number
  as `expectedPreemptEpoch` with the generation on the initial Play only, not on Resume. Before
  any engine Play, the helper rejects a mismatch with the current preemption reason. So an
  interrupt landing before Play arrives is caught by the epoch binding, and one landing after
  it is caught by the existing lease fence.
- The legacy repeat/restart path and unavailable/provider-restricted media remain
  separate live qualification targets; this patch does not promise full-length Free playback.
- Uncached repository verification reached pre-existing Dex origin/receipt fixture
  failures. Legitimate command-origin fixtures must be repaired without bypassing
  authorization. Interrupted-send retry versus committed-receipt replay needs explicit
  contract review. Historical World Book failures are not current proof if that lane
  is not reached by final verification.

## Primary source references

- [Spotify iframe API](https://developer.spotify.com/documentation/embeds/references/iframe-api)
  documents initial controller URI, restart, playback events and podcast seeking.
- [Spotify embed troubleshooting](https://developer.spotify.com/documentation/embeds/tutorials/troubleshooting)
  distinguishes full playback from previews and encrypted-media availability.
- [Playwright locator clicks](https://playwright.dev/docs/api/class-locator#locator-click)
  describe real browser input/actionability, rather than dispatched DOM events.

## Lane 2: shared queue/completion contract

`EveAudioflix.queueConnection.playbackRunId` (`queueRunId` in `audioflix.ui.js`) is the only
queue-run authority. Ownership trace:

- Run bumps: `playQueueIndex` (Play Group, Queue View/internal-player step and jump, WatchFusion
  step/jump, completion advance); `invalidateRun` (Queue View opening a new queue, Stop Group,
  completion/explicit Restart). Reorder (`move`, `playNext`, Shuffle Order) keeps the run, so a
  pending completion advances from the latest order.
- Ended listeners, all keyed on (entry, playbackRunId) and all rechecking the run after `settle`:
  the canonical coordinator (`audioflix.queue.completion.js`, which owns repeat-one vs advance),
  the Spotify fast path in `audioflix.ui.overlay.js` (advance only, never repeat) and the 0ms
  fallback in `audioflix.transport.resilience.js`. The first to act bumps the run; the others
  then see a different run and do nothing. WatchFusion and the internal player only call
  `queueConnection` step/jump/move/action and have no completion owner of their own.
- Stale-delivery fence: the coordinator claims each Ended callback object for the run it
  completed (`WeakMap`, no new token). Repeat-one keeps the same entry across runs, so a late
  re-delivery of an already consumed callback used to look like a fresh completion of the
  restarted run. The coordinator and both fallbacks now drop it (`isStaleDelivery`).
- Repeat-one restart for managed Spotify: `restart()` bumps the run, then `seek(0)`. The
  repeat-rearm wrapper maps ended->0 to the broker `restart` and waits for the client to rearm,
  and `playItem` then sees the same active, non-ended item and does no second Load. One owner,
  so nothing was consolidated.
- Live-only boundary: providers mint a fresh Ended object per emission and dedupe their own
  completions (managed `completionId`, embed `ended` flag). A provider that emits a *new* Ended
  object for an old repeat-one playback after restart is fenced only by that provider dedupe.
  Nova should check repeat-one on live signed-in Spotify.

Deterministic coverage: `tools/smoke/audioflix_queue_completion_contract_smoke.js` (run by the
managed lane through the browser contract smoke).

## Lane 3, first local checkpoint (base `57487c76`)

This is a focused checkpoint, not a sealed Lane 3 or final Windows/provider qualification.

- Managed volume retains one relay flight and one replaceable latest intent. Burst inputs
  coalesce, the final value is delivered after failures, and old run/owner results cannot
  repaint the replacement playback. Commands carry the accepted ownership/engine/generation
  markers, but the existing broker does not yet enforce those markers on volume mutations;
  same-URI old-generation mutation protection remains a server-side follow-up.
- Status-watch retries transient failures with bounded exponential delay, stops after five
  unsuccessful attempts with explicit degraded status, and serializes observer restarts behind
  the preceding bounded read. Late run/token/cursor results and post-exhaustion progress reads
  cannot repaint state. Fifty rapid observer restarts retain one job, one request and one
  presentation timer; settled stop leaves zero jobs/requests/timers. In-flight relay reads are
  invalidated rather than aborted; their existing transport deadlines remain authoritative.
- The reused Internal Player updates title/source/current-item presentation from canonical
  playback metadata without reopening its provider frame or changing queue ownership.
  A real-pointer isolated Playwright regression reproduced Young Girl A versus 16 before the
  fix and proves consistent headings through queue selection, steps, collapse and reopen.

The new watch recovery regression fails on the sealed base (no retry after a transient failure)
and passes on this correction. Volume burst regression likewise reproduced unbounded outbound
requests before the fix. Its ignored before/candidate artifacts live under
`data/runtime/smoke-results/audioflix-spotify-volume/` and explicitly use a serialized relay
stub with synthetic delay. They are not Spotify, browser-process or network latency evidence.
In the measured 50/100-input trials, helper mutations fell from 50/100 to two and peak outbound
requests from 50/100 to one. Existing saved libraries/profiles/services were not mutated.
The synthetic final-value latency baseline was p50 777.85ms, p95/max 1556.46ms; the latest
candidate was p50 29.47ms, p95/max 30.47ms (six trials, Windows timer granularity applies).

The volume profile exposed an unchanged Lane-2 fixture mismatch in
`audioflix_volume_views_smoke.js`: its raw-provider Ended fallback assertion contradicted the
sealed removal of that fallback. The fixture now requires canonical Ended, settlement and stale
callback/run fences, and forbids unversioned raw-message completion. Production completion code
was not changed; all four volume-profile children pass.

The Windows managed lane also reproduced the pointer watch item during fixture setup: a
visible Frontend toggle was replaced between visibility and bounding-box protocol calls.
The captured DOM/screenshot showed a normal visible button, no page errors, and no failed
file requests; no queue assertion had run. The fixture now waits for connected positive
geometry on the current node before the existing real-pointer/actionability click. Hidden or
zero-sized targets still fail. The focused queue completion contract subsequently passed.

Windows also exposed a fixture-only deadline mismatch: three refused localhost interrupt
connections took 2.047-2.063s, returning the expected failure within the authoritative 2.5s
private RPC deadline. The old smoke's undocumented subsecond assumption was invalid on this
host. Its refused/hung checks now use that existing deadline plus the existing one-second
scheduler allowance, and pin the production deadline at no more than 2.5s; subsecond
preemption/control-path assertions and all production timing remain unchanged.
The private-helper fixture also waits for its own child to finish graceful browser shutdown
before removing its validated task-specific temporary profile, with bounded lock retries.

Checkpoint gates: structural guardrails, four-child volume profile, Spotify playback/status
watch lane, heading-only real-pointer fixture, and every managed-lane child passed locally.
The managed lane is composite evidence: its contract/runtime/lease children passed in the
parent invocation, and the corrected preemption plus remaining manager/browser children
passed separately after that parent stopped. It is not a claim of a fresh all-in-one master
pass, a real Spotify endurance pass, or uncached full repository acceptance.

Still open: suspension/resume and helper-restart integration, cheap snapshot/read coalescing,
server-side volume generation checks, real-runtime latency/resource evidence, broader
background completion qualification and the subsequent Lane-4 service reload work. Full
uncached repository verification and final signed-in endurance remain deferred to the agreed
post-Lane-4 qualification gate; do not merge, deploy or delete rollback branches here.

## Lane 3 continuation after `3c871b034`

The first checkpoint was pushed as `3c871b034c1c614998e2491be5901714d0a323a3`.
The following changes continue from it; they do not replace Lane-1 lifecycle or Lane-2 queue
authority, and do not claim final live-provider acceptance.

- Status reads reuse the transport snapshot already included in the helper's status packet.
  Explicit mutation replies retain precedence. Missing/malformed legacy snapshots keep the
  existing fallback. There is no TTL cache or new cross-command singleflight cache that could
  hide a mutation. Thirty synthetic observations fell from 90 helper requests to 30;
  p50 46.513->15.633ms, p95 47.828->16.099ms, max 47.866->16.286ms. This uses the actual
  Python broker/RPC/manager path with a fake helper and 2ms artificial request delay; Windows
  timer granularity dominates, so these are not live Spotify measurements.
- Marked volume commands require the complete valid owner/engine/track-generation tuple,
  current ownership, and the fresh helper generation before mutation. They cannot reacquire
  ownership after Stop. Private RPC rechecks helper identity and generation under its manager
  lock. Same-URI replay, ownership round trip, Stop, observed/unobserved helper restart, and
  validation-to-dispatch identity/generation changes reject without volume mutation. Missing
  or malformed generation fails closed for marked commands. Deliberately unmarked legacy
  callers retain their old behavior; do not describe those callers as generation-fenced.
- Observation and relay-cache ordering use durable engine/owner/generation/cursor markers,
  including direct control replies. A late same-generation Playing/Ended packet cannot undo
  a newer confirmed Pause/Seek. A new helper epoch may report generation zero without being
  discarded as an old generation. Broker counters are scoped to the client grant; a new relay
  grant clears the previous cached state rather than treating counters as globally permanent.
- Freeze suspends observation and invalidates pending callbacks, preserving the accepted
  seed/run. Resume reobserves the durable state without a Play/Resume command or helper launch.
  Public Stop removes resume eligibility. Observer disposal removes its lifecycle listeners.

The isolated native Chromium lifecycle fixture passes for HTTP and file entrypoints: 22
trusted freeze/resume pairs, no callbacks while frozen, one consumed completion after thaw,
Pause preserved, Stop preventing reconnect, and settled observer resources at zero after
disposal. Peak watch/status requests remain one each. This uses fake durable packets and a
deduping fixture consumer, not the real queue owner or signed-in Spotify endurance. The
existing Playwright Chromium is launched through raw CDP to avoid Playwright's forced-focus
capturer masking freeze. The test-only WebSocket fallback reuses Playwright's pinned bundle;
the forced fallback passed on Node 24, but an actual Node 20 runtime has not been qualified.

Final continuation evidence was captured by `test:handoff` with deliberate branch/divergence
and dirty-worktree overrides for this uncommitted development batch. Structural guardrails
passed (13.1s), the full registered Spotify playback/observer lane passed (177.4s), and the
four-child volume lane passed (2.0s). The broader deterministic deep profile passed its first
seven entries, then stopped at the known World Book static assertion in
`world_book_integration_smoke.py:71`: the client no longer contains
`window.setTimeout(() => { void refresh(); }, 0)`. The assertion and client Git blobs are
unchanged from sealed base `57487c76`; this batch does not fix that unrelated red. Later deep
entries were not run, and neither deep nor overall acceptance is all-green. Local full
evidence: `data/runtime/smoke-results/chat-handoff-2026-10-10T10-57-00-260Z.json` and its log.

Qualification boundaries:

- Status-watch still performs bounded server-side polling; snapshot reuse removes duplicate
  reads but is not a push/event-only implementation or proof of native CPU/memory targets.
- In a genuinely frozen page, timers and fetch callbacks cannot run. The canonical queue owner
  is still the EveOS frontend, so it cannot advance while that page is frozen; observation can
  drain durable completion after thaw. Hidden/throttled is not the same state as frozen.
  See [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
  Moving/protecting that owner for uninterrupted frozen-page playback is an architecture
  decision for Eve, not permission to add a competing queue scheduler.
- Restart the identity-verified EveOS backend before real-provider qualification of the Python
  changes; refreshing the browser cannot reload server modules. No user's live services,
  profile, library or playback were changed by the isolated tests here.
- Remaining acceptance: signed-in natural-duration/background endurance, repeat-one and
  shuffle/reorder during playback, Play Group without opening Queue View, reconnect/reload,
  actual boot/input/transition p50/p95/max and memory/CPU evidence, then Lane-4 scoped reload
  and the agreed uncached repository gate. Do not merge/deploy/delete rollback branches yet.

## Lane 3 Windows closure and Queue View volume binding

Windows acceptance continued from `8518e155f7418568650c87688c28d4cb6dd2f819`.
The identity-verified web backend was restarted through Local Control, not by killing a port.
Replacement PID 205848 started at 2026-10-10T07:08:09.238619-04:00; Local Control stayed up.
An isolated controller, blocked library writes and retained signed-in managed Edge profile
proved Play Group without Queue View and one full 92.636-second, no-seek natural transition.
The Ended-to-confirmed-playing interval was 4160ms. Twelve real status calls measured
p50 36.8ms, p95/max 50ms; these are warm short-session samples, not baseline comparisons.
Thirty-seven resource samples found one watch flight/job and one progress timer/request
at most. Sampling includes test overhead and summed working sets can double-count shared
pages; neither these samples nor a seek-assisted test establishes long-run leak freedom.

A subsequent human report exposed a separate, reproduced mirror binding defect: title and
progress followed the next managed item, but Queue View's volume and resume callbacks still
captured the item that originally opened the mirror. Song #2 slider input never reached the
managed volume lane. The correction resolves current managed playback on every input,
refreshes mirror item/volume presentation and persists volume through the shared state path.
It does not weaken broker generation fencing, add a queue scheduler or reopen provider frames.
The existing registered queue-surface smoke now pins this regression, including an input
before the next progress/render delivery and resume targeting the new item.
Checkpoint gates passed: structural guardrails, the registered Spotify playback/watch lane
(181.1s), the four-child volume lane (2.0s), and the strengthened VM/real-pointer queue-surface
smoke (2/2). Assets were synchronized explicitly before verification. Full verify was not run.

Real signed-in Windows pointer testing passed volume on three distinct songs with the same
Queue View left open through two seek-assisted transitions: helper-applied levels were
0.08, 0.14 and 0.09, with fresh application timestamps and matching current track identities.
Library and structural digests were unchanged. Ignored evidence is under
`data/runtime/smoke-results/LAST-LANE3-VOLUME-TRANSITION.json`; the red reproduction is
`LANE3-VOLUME-TRANSITION-BEFORE-FIX.json`. First-run timing/resources are recorded separately
in `LAST-LANE3-RUNTIME-ACCEPTANCE.json`, so later focused runs cannot erase that evidence.

Still not sealed: genuine-hidden full-duration handoff, repeat ON/OFF natural endings,
shuffle/reorder, helper/relay reconnect, reload and the file entrypoint live matrix.
Playwright's forced-focus capture kept the first minimized controller `visible`; this is
not a background pass or an Audioflix failure. The isolated headed raw-CDP adapter proved
hidden/visible transitions in a scratch fixture, but the remaining provider matrix has not
yet passed with it. Take exclusive playback control only with the user's authorization.
Resume the ignored `lane3-runtime-acceptance.mjs --native --continue-native` harness (add
`--take-over` only when authorized), then proceed to Lane 4. Final endurance and uncached
full-repository verify remain deferred to the agreed post-Lane-4 gate. No merge/deployment
or rollback-branch deletion is authorized by this checkpoint.

### Natural repeat observation correction (base `8fc8570e`)

The native signed-in acceptance pass proved a full-duration hidden handoff and a natural
repeat ON, but repeat OFF after moving the playing entry to #1 stalled. The observer
returned on the first Ended while the same-item restart retained the managed client run.
All 53 repeated-run samples then reported `watchJobs=0` despite state `watching`. Once
the controller became hidden, presentation polling correctly stopped and could no longer
mask the missing authoritative watch. This was an observation lifetime defect, not a
second queue-owner requirement or proof of a browser freeze.

The bounded status watch now survives durable Ended while playback remains active. A
same-track restart and its subsequent Ended are observed without polling-based rearm;
stop, run supersession, unsupported watch and degraded recovery still terminate it.
Audioflix remains the sole completion/queue owner. The registered recovery smoke pins
the exact pre-fix SHA as red and tests hidden same-URI restart, two distinct completion
identities, duplicate durable packets, single-flight bounds and settled stop/dispose.
Structural guardrails and the full registered Spotify playback/watch lane passed.
Assets were synchronized explicitly. The server source did not change, so the existing
identity-verified backend start time remains applicable.

The original failed live evidence is preserved in ignored
`data/runtime/smoke-results/LANE3-REPEAT-WATCH-BEFORE-FIX.json`.
The corrected exact-head native HTTP acceptance and separately approved canonical file
entrypoint matrix remain the closure gate; do not infer acceptance from deterministic
tests alone. Lane 4, sustained endurance and the final uncached repository gate remain
deferred. No merge, deployment or branch cleanup is part of this correction.
