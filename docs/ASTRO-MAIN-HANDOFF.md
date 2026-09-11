# Astro ↔ EveOS Main Handoff

`main` is the canonical EveOS development branch again.

## Branch policy

- Work on `main`.
- Do not restart `Eve-Branch` as a separate development line.
- `Eve-Branch` was fully fast-forwarded into `main`; no unique branch-only implementation should remain.
- Before changing code, pull/fetch the current `main` HEAD and treat it as authoritative.

## Recent stabilization pass

Eve audited the late Piano Auto Player commit cluster and fixed the following issues directly on `main`:

1. Removed the high-frequency Win32 `OpenWindowStationW` / `OpenDesktopW` path that leaked handles during foreground checks.
2. Added a last-moment foreground-target interlock to note-lifecycle playback and retries the due batch after focus returns instead of silently skipping it.
3. Changed custom identifier semantics so an explicit `custom` object replaces the previous custom-key set, allowing deleted keys to stay deleted.
4. Changed advanced metadata saves to send only `{ id, identifiers }`, preventing a stale planner snapshot from overwriting sheet/performance payloads.
5. Replaced Advanced Playback's DOM-button/index choreography with the Player Queue controller contract (`playerQueueReady()` / `addSongs()`).
6. Made queued playback refuse to click Play when the requested library song did not actually finish loading.
7. Removed an imported-metadata `innerHTML` sink from the planner; automatic metadata values now render as text nodes.
8. Stopped swallowing dynamic module-import failures; Piano surfaces/logs Player Queue and Sheet Progress load failures.
9. Added regression guards for the queue/planner contracts and metadata payload/custom-key behavior.

## Files touched by the stabilization pass

- `tools/Piano-Auto-Player/app/window_focus.py`
- `tools/Piano-Auto-Player/app/performance_lifecycle.py`
- `tools/Piano-Auto-Player/app/library.py`
- `tools/Piano-Auto-Player/web/player_queue.js`
- `tools/Piano-Auto-Player/web/player_queue_advanced.js`
- `tools/Piano-Auto-Player/web/eveos-host-bridge.js`
- `tools/Piano-Auto-Player/tests/test_metadata_integrity.py`
- `tools/smoke/piano_player_queue_smoke.js`
- `tools/smoke/piano_metadata_planner_smoke.js`

## Astro verification job

Treat this as a verification/hardening pass, not a rewrite.

1. Pull the latest `main`.
2. Run `npm run verify` from the EveOS repository root.
3. Run the Piano Python tests, including:
   - `tools/Piano-Auto-Player/tests/test_last_moment_target_interlock.py`
   - `tools/Piano-Auto-Player/tests/test_metadata_integrity.py`
4. On Windows, manually exercise foreground-target playback and note-lifecycle playback:
   - start playback into the intended target;
   - switch focus immediately before/during a note;
   - confirm no new note-down input reaches the wrong foreground window;
   - return focus and confirm playback resumes rather than dropping the pending lifecycle batch.
5. Watch the process handle count during an extended Piano session / repeated focus checks and confirm it stays bounded rather than growing continuously.
6. Exercise Advanced Playback metadata editing:
   - open a song in the planner;
   - modify the same song payload elsewhere;
   - save only metadata from the planner;
   - confirm sheet/performance/source payload remains unchanged;
   - add two custom keys, delete one, save, and confirm the deleted key stays deleted.
7. Exercise queue/planner behavior:
   - Send to Queue, Replace Queue, Play selected, Shuffle selected;
   - confirm the planner uses the queue controller contract;
   - simulate/force a library-load failure or timeout and confirm the old song is not played accidentally.
8. Confirm imported/hostile-looking metadata renders literally as text in Advanced Playback and does not become HTML.
9. Confirm a failed optional Piano module import is visible in console/status UI rather than silently disappearing.

## Constraints

- Preserve the current architecture and feature behavior unless a reproducible regression requires a change.
- Do not reintroduce DOM text matching/index coupling between Advanced Playback and Player Queue.
- Do not reintroduce full-song metadata writes from the planner.
- Do not reintroduce high-frequency Win32 window-station/desktop opens.
- Keep first-party source files under the repository's 450-line cap.
- If verification finds a bug, make the smallest targeted correction on `main`, add regression coverage, run the affected tests again, then report the exact commit SHA and results.

## Report back

Return:

- current `main` HEAD;
- `npm run verify` result;
- targeted Piano test results;
- Windows focus/handle-count result;
- queue/planner manual test result;
- any additional bug found and exact fix commit;
- confirmation that `main` is the only active EveOS development line.
