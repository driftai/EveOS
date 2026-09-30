# WatchFusion Project Rules

## Module-size guardrail

- Keep new JavaScript modules at or below 450 lines.
- Split by responsibility before crossing the limit; do not grow grandfathered legacy modules with unrelated work.

## Smoke-output guardrail

- Treat smoke-output efficiency as an enforced project invariant, equal to the 450-line module rule.
- Run the smallest affected profile first with `npm run --silent test:smoke`, `test:deep`, `test:browser`, `test:integration`, or `test:security`.
- Run `npm run --silent test` once at the final integration gate. Do not rerun an unchanged passing suite without a new code, configuration, dependency, or environment reason.
- The fast profile may reuse a prior pass only when its source/test and Node-environment fingerprint is identical. Never reuse full, browser, integration, security, or final-release verification.
- Successful non-verbose verification must print one stable summary line. Passing assertions, DOM, responses, frames, JSON, and subprocess chatter stay suppressed.
- A failure must retain a nonzero exit code, identify stable failing IDs, and print no more than 40 relevant lines per failure.
- Store complete bounded diagnostics under ignored `test-results/`. Detailed passing output is allowed only through an explicit verbose command.
- Never reduce coverage, hide actionable warnings, or treat cached/old results as a final verification pass merely to save output.

## External Nuvio integration boundary

- Treat the installed Nuvio application under `tools/WatchFusion/nuvio` as external user-side software, not as first-party WatchFusion source.
- Integrate through wrapper-owned connectors: generated runtime environment, WatchFusion HTTP/proxy routes, same-origin iframe/runtime injection, and narrowly scoped response adaptation at the WatchFusion boundary.
- Do not add new persistent rewrites of upstream Nuvio core modules to fix WatchFusion behavior. Existing source-patch scripts are migration debt: when work touches them, prefer moving the behavior into wrapper-owned injection/connectors and reducing the patch surface rather than expanding it.
- Never commit, replace, reset, or clear the user's installed Nuvio source, build output, profile, storage, or authentication state as part of normal WatchFusion development.
- Preserve the canonical host-side Nuvio origin (`http://127.0.0.1:9087/...`) so login/storage identity is stable across EveOS, WatchFusion, and Nuvio.
- Keep host-capability bridges host-local. A Cloudflare/LAN transport is not authorization for local plugin networking, filesystem controls, diagnostics, or credentials.
- Use `https://github.com/driftai/Side-Builds/tree/main/Nuvio-Onion-Wrapper` as the architectural reference for the external-install/wrapper boundary when Nuvio integration behavior is ambiguous.
- Optimize Nuvio boot/reopen work at the wrapper lifecycle boundary first (iframe reuse, bounded readiness, caching, request fan-out) before changing upstream Nuvio internals.


## Linked tab architecture (2026-09-30)
- A linked browser tab is a **state/control adapter**, not a video relay. Do not reintroduce tabCapture/canvas/WebRTC pixel streaming for ordinary attached sites.
- The companion publishes the current page URL plus playback state (play/pause, position, rate, volume, next/previous controls). WatchFusion resolves that URL through the existing Find Media provider registry and plays the resolved source locally/in the room.
- Miruro must reuse the canonical media resolver. The client remembers the selected Miruro server/audio preference and reuses it on later episodes/pages; first-use Miruro prefers a dub candidate when available.
- YouTube attachments use the WatchFusion YouTube iframe player and follow the attached page URL/state. Source-page pixel quality is not part of the transport.
- Attachment is passive by default: do not restyle/resize the source page, force quality, replace media, enter fullscreen, click controls automatically, or capture pixels. Sampling may read URL/media state; page writes are allowed only for an explicit WatchFusion transport command.
- The source tab may be muted at the browser-tab level while attached to prevent duplicate local audio, but its original mute state must be restored exactly. This browser-level mute must not change the page player's own volume/mute state.
- MAIN-world web-component listeners and isolated-world probes must both be disposed on unlink and before reinjection so extension reloads/upgrades cannot leave stale observers behind.
- Audioflix remains a real WebRTC audio stream. Auto audio sync uses measured playout timestamps when the browser exposes them; otherwise it uses the device's remembered calibration, with a physically-qualified 335 ms mobile seed and 0 ms desktop seed.
- Audioflix is audio-only in the WatchFusion media stage: keep its transport/queue controls visible, but do not reserve or render a black video canvas unless the received stream actually contains a live video track.
- The horizontal Watch Party divider must preserve at least 280 px of embedded media height on laptop-size layouts.

- LAN share UI must derive from the selected EveOS exposure context as a fallback when host-local network diagnostics are temporarily unavailable. "Copy LAN link" is room-only UI and must never remain visible in solo mode.
- Host-local diagnostics may accept the host machine's own physical IP/sslip hostname only when the request socket is also one of that same machine's interface addresses; remote LAN clients remain outside the host-local capability boundary.

- In embedded Audioflix rooms, the reserved media-workspace height should be useful: expand the Music Library queue through the audio-only control area instead of leaving a large dead gap. Preserve the existing Watch Party splitter behavior.
