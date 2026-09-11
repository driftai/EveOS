# Astro ↔ EveOS Main Handoff

`main` is the canonical EveOS development branch.

## Branch policy

- Work on `main`.
- Do not restart `Eve-Branch` as a separate development line.
- The former branch history has been reconciled into `main`; `Eve-Branch` is only a compatibility pointer and should contain no unique implementation.
- Before changing code, pull/fetch the current `main` HEAD and treat it as authoritative.

## Recent Piano stabilization pass

Eve audited the late Piano Auto Player commit cluster and reconciled the fixes that were developed concurrently on `main` and `Eve-Branch`.

The resulting `main` implementation now:

1. Removes high-frequency `OpenWindowStationW` / `OpenDesktopW` desktop rebinding from foreground checks and removes the obsolete focus-guard rebinding call.
2. Rechecks the actual target foreground state throughout note-lifecycle waiting and immediately before lifecycle key emission; a due batch is rewound/retried after focus returns instead of leaking or being silently dropped.
3. Gives custom identifier edits replacement semantics when `custom` is explicitly supplied, so deleted custom keys stay deleted.
4. Uses the dedicated `POST /api/songs/identifiers` route backed by `SongLibrary.update_identifiers()`; Advanced Playback no longer sends a stale full-song snapshot through the generic save route.
5. Exposes metadata-only updates through `web/api.js` and sends only song ID + identifiers.
6. Replaces Advanced Playback's library-card/index/button-text choreography with the Player Queue controller (`window.PianoPlayerQueue` / `addSongs`).
7. Makes queued playback refuse to click Play if the requested library song did not actually finish loading.
8. Renders automatic/imported metadata through DOM text nodes rather than an `innerHTML` sink.
9. Surfaces optional Piano module-load failures in console/status UI and dispatches `piano:module-error` rather than silently swallowing them.
10. Adds regression coverage for lifecycle focus loss, metadata-only payload preservation, custom-key replacement/deletion, queue load safety, planner/controller decoupling, and module diagnostics.

## Relevant files

- `tools/Piano-Auto-Player/app/window_focus.py`
- `tools/Piano-Auto-Player/app/focus_guard.py`
- `tools/Piano-Auto-Player/app/performance_lifecycle.py`
- `tools/Piano-Auto-Player/app/library.py`
- `tools/Piano-Auto-Player/app/server.py`
- `tools/Piano-Auto-Player/web/api.js`
- `tools/Piano-Auto-Player/web/player_queue.js`
- `tools/Piano-Auto-Player/web/player_queue_advanced.js`
- `tools/Piano-Auto-Player/web/eveos-host-bridge.js`
- `tools/Piano-Auto-Player/tests/test_last_moment_target_interlock.py`
- `tools/Piano-Auto-Player/tests/test_library_metadata_updates.py`
- `tools/Piano-Auto-Player/tests/test_metadata_integrity.py`
- `tools/smoke/piano_player_queue_smoke.js`
- `tools/smoke/piano_metadata_planner_smoke.js`

## Astro verification job

Treat this as a verification/hardening pass, not a rewrite.

1. Pull the latest `main` and record its exact HEAD before doing anything.
2. Run `npm run verify` from the EveOS repository root.
3. Run the relevant Piano Python test suite, explicitly including:
   - `tools/Piano-Auto-Player/tests/test_last_moment_target_interlock.py`
   - `tools/Piano-Auto-Player/tests/test_library_metadata_updates.py`
   - `tools/Piano-Auto-Player/tests/test_metadata_integrity.py`
4. On Windows, manually exercise foreground-target sheet playback and note-lifecycle playback:
   - start playback into the intended target;
   - switch focus immediately before/during a note;
   - confirm no new note-down input reaches the wrong foreground window;
   - return focus and confirm playback resumes and the pending lifecycle batch is not lost.
5. Watch the process handle count during an extended Piano session/repeated focus checks and confirm it stays bounded rather than growing continuously.
6. Exercise Advanced Playback metadata editing:
   - load a song in the planner;
   - modify the song payload elsewhere;
   - save only metadata from the planner;
   - confirm sheet/performance/source payload remains unchanged;
   - add two custom keys, delete one, save, and confirm the deleted key stays deleted;
   - save an empty custom set and confirm prior custom keys are removed.
7. Exercise queue/planner behavior:
   - Send to Queue;
   - Replace Queue;
   - Play selected;
   - Shuffle selected;
   - confirm the planner talks to the queue controller rather than locating library cards/buttons;
   - simulate/force a library-load failure or timeout and confirm the previously loaded song is not played accidentally.
8. Confirm hostile-looking/imported metadata renders literally as text in Advanced Playback and does not become executable HTML.
9. Confirm a failed optional Piano module import is visible in console/status UI and emits `piano:module-error`.
10. Check the resulting diff for unrelated changes. If all tests pass, do not refactor further.

## Constraints

- Preserve the current architecture and behavior unless a reproducible regression requires a change.
- Do not reintroduce Planner ↔ Queue DOM index or visible-button-text coupling.
- Do not reintroduce full-song metadata writes from the planner.
- Do not bypass the dedicated metadata-only endpoint for planner identifier edits.
- Do not reintroduce high-frequency Win32 window-station/desktop opens or desktop rebinding.
- Keep first-party source files under the repository's 450-line cap.
- If verification finds a bug, make the smallest targeted correction directly on `main`, add regression coverage, rerun affected tests, and report the exact commit SHA.

## Report back

Return:

- starting and ending `main` HEAD;
- `npm run verify` result;
- targeted Piano test results;
- Windows focus/handle-count result;
- queue/planner manual test result;
- metadata integrity/security test result;
- any additional bug found and exact fix commit;
- confirmation that `main` remains the only active EveOS development line and `Eve-Branch` has no unique commits.
