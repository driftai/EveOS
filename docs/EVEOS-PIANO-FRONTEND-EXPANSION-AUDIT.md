# EveOS Piano Frontend Expansion Audit

Baseline: `eve/nexus-machine-spaces` at `2e290064a885157a28c82b4c1a6b87632b381b82`.

## Authority boundaries

- `SongLibrary` and `songs.json` remain the only durable Piano song metadata owner.
- `PianoPlayerQueue` remains the only queue owner. The regular frontend and Piano Internal View are projections of its snapshots and commands.
- `PianoPlaybackOwner` remains the only play, pause, stop, and queue-transition owner.
- The EveOS frontend may render optimistic interaction state, but it must reconcile from Backend receipts and must not create a second queue or persistence store.
- Music Library presentation patterns may be adapted, but Spotify, generic URL playback, localization health, AudioFlix Music gain, and destructive generic duplicate merging are not Piano contracts.

## Versioned per-song playback contract

`identifiers.custom.piano_playback_v1` is a backend-validated object:

```json
{
  "route": "inherit",
  "targetHint": null,
  "layout": null,
  "instrumentId": null,
  "internalVolumePercent": null
}
```

Allowed routes are `inherit`, `internal`, and `target`. Layout is `null`, `61`, or `88`. Volume is `null` or an integer from 0 through 100; zero is intentionally silent, not inheritance. Target hints are revalidated against current target options immediately before playback. Unsupported instruments and missing targets fail visibly instead of silently falling back to another window.

Old songs remain readable without migration. Saving an override writes the normalized object. Re-saving is idempotent, record IDs are unchanged, and malformed values are rejected before disk writes.

## Module plan

- Backend validation: `tools/Piano-Auto-Player/app/library.py`.
- Runtime resolution/application: a small `web/piano_playback_settings.js` helper wired through `piano_frontend_app_bridge.js`, `app.js`, `piano_controls.js`, and `piano_sound.js`.
- Frontend cards/settings/duplicate suggestions: new bounded AudioFlix Piano modules rather than expanding the 439-line ports or real-app smoke files.
- Group/folder/classifier tri-state focus: the existing organizer remains the UI owner and exposes a pure song predicate.
- Internal queue view: a second projection over the existing port snapshots and queue commands.

## Recovery and acceptance

The pre-change `songs.json` and baseline manifest are stored under `C:\Users\alvin\Downloads\EveOS-Piano-Expansion-Phase0-20261030-162809-298`. Its copied song database SHA-256 is `2392D64E707F2F550FC1D2BA137DE0B915C7FAE25EBADE05F319334A5A0C60F1`.

Qualification proceeds from pure schema/runtime tests to the focused Piano browser suite, shared AudioFlix regressions, guardrails, then one final uncached verify. Tests must cover backward-compatible reads, invalid override rejection, direct and queue playback resolution, target loss, volume 0/100, no setting leakage, two queue projections, duplicate suggestions, tri-state focus, accessibility, and narrow layouts.
