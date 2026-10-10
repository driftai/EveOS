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
