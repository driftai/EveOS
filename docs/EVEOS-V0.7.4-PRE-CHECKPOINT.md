# EveOS V0.7.4-pre development checkpoint

## Designation

`51f970cf9ed31deafeb4b06094345465c9cba96e` is the shared
V0.7.4-pre **source baseline** for `main` and `eve/nexus-machine-spaces`.
It is a development checkpoint, not a final V0.7.4 release, release tag, or
claim that every inherited acceptance lane is complete.

Before this document was created, the remote branches were independently read
back at that exact commit with identical commit and tree identities and a `0/0`
ahead/behind relationship. This documentation checkpoint belongs only to
`eve/nexus-machine-spaces` and has the shared source baseline as its immediate
parent. It deliberately introduces no executable difference from `main`.

## Accepted development foundation

The shared baseline preserves the usable infrastructure developed through the
Machine Spaces lane, including:

- durable Dex scheduling, exact-room routing, provider-control provenance, and
  bounded delivery/recovery behavior;
- Machine Spaces grants, supervised terminals, execution receipts, recovery,
  and uncertainty/no-replay handling;
- TLO-originated registered Playwright preparation and an exactly-once
  supervised browser execution proven against the live provider path;
- Navigator's grant-scoped discovery and current-target revalidation model;
- provider-neutral capability context and optional per-room middle-agent
  foundations;
- Governor qualification/publication integration and guarded non-force Git
  publication; and
- Nexus Browser, terminal/TUI, Local Control, and Search Monitor reliability
  improvements accumulated on the lane.

These capabilities are available for selective reuse. Their presence does not
promote every V0.7.1–V0.7.5 milestone to `DONE`, nor does one successful live
path establish all-provider, failover, stress, or cross-subsystem acceptance.

## V0.7.5 deferral decision

The V0.7.5 De-Middleman initiative is **DEFERRED**, not cancelled or declared
complete. Further narrow expansion currently offers diminishing returns when
compared with hardening the broader EveOS ecosystem. The remaining autonomous
end state may be resumed from this preserved foundation when it again becomes a
priority and has a bounded acceptance plan.

Deferred objectives include:

- the complete autonomous agent → inspect/edit → test → commit → guarded
  publication workflow as a repeatable product capability;
- additional provider-neutral middle-agent live acceptance;
- middle-agent loss, failover, reconnect, and operational stress qualification;
- browser-independent TLO activation and browser-closed inference proof;
- remaining V0.7.1–V0.7.4 acceptance gaps;
- V0.7.5 cross-subsystem propagation and acceptance; and
- unresolved safety gates, including any uncertain deployment outcome.

Existing milestone evidence retains its original meaning. Unqualified work is
not relabelled as completed merely because development has paused.

## Development direction after this checkpoint

The next cycle should prioritize the broader EveOS ecosystem:

- AudioFlix playback, queue, library, and recovery reliability;
- WatchFusion stability and integration;
- Search Monitor and Local Control quality;
- Notes, World Book, Unidex, and other data surfaces;
- Bookmarks/INSITE;
- UI responsiveness, startup reliability, and service lifecycle; and
- integration security, durable user data, diagnostics, and recovery.

Dex, Navigator, Machine Spaces, Governor, and registered Playwright remain
enabling tools. They should be reused where they materially accelerate this
work without becoming the dominant objective by default.

## Preservation and resumption boundaries

- Preserve the 14 original durable Dex rooms and their state.
- Preserve the uncertain Phase 3D deployment journal exactly; do not replay it
  or infer successful activation.
- Do not activate or restart TLO for this checkpoint.
- Preserve `eve/nexus-machine-spaces`; do not merge unrelated branches.
- Keep credentials, runtime evidence, process identities, and machine-local
  artifacts out of Git.
- Resume deferred autonomy work only through an explicit new priority decision,
  current-source review, and evidence appropriate to the affected boundary.

This checkpoint records the pivot and stops. It does not start the broader
hardening work described above.
