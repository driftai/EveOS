# Astro ↔ EveOS `Eve-Branch` Canonical Handoff

This file is the durable handoff between Eve and Astro. Read this before making further changes on `Eve-Branch` so the work does not depend on chat history.

## Branch policy

- Work only on `Eve-Branch` for this effort.
- Do **not** modify `main`.
- `main` baseline remains `52d4e6ef8331c20c06a4c8d1b1867760e34af0b5`.
- `Eve-Branch` is intentionally ahead of `main` and contains the current Instagram hardening plus Piano/YouTube work.

## Core architecture decision

EveOS should prefer **public, cookie-free, provider-independent access wherever legitimately possible**.

Authentication is an optional capability for genuinely restricted/account-bound content, not a prerequisite for normal public media.

Provider failures must remain isolated from the playback/transcription pipeline.

## Instagram: completed architecture

The Instagram resolver evolved from an authentication-first assumption to a public/provider-ladder architecture.

The current resolver pattern is:

`Instagram URL`
→ `yt-dlp`
→ `public extraction`
→ `InDown public HTTP resolver`
→ `Camofox`
→ `LightPanda`
→ `webpage fallback`

Implemented through `RESOLVER_PROVIDERS` in `server_modules/audioflix_instagram.py`.

Supported URL forms are normalized through the same resolver path where applicable:

- `/p/<shortcode>/`
- `/reel/<shortcode>/`
- `/reels/<shortcode>/`
- `/tv/<shortcode>/`

Media resolution and metadata enrichment are deliberately decoupled. A metadata failure must never prevent video playback.

### Proven Instagram test

Canonical public test:

`https://www.instagram.com/p/DS2r6KBDNCS/`

Verified behavior from the completed integration pass:

- yt-dlp can fail with an empty Instagram media response.
- Public fallback can resolve the post without requiring Instagram account cookies.
- InDown returns a direct Facebook CDN MP4.
- EveOS proxy successfully serves ranged media with `HTTP 206 Partial Content`.
- `video/mp4` and MP4 `ftyp` signature were verified.
- Duration was extracted from the Facebook CDN URL's base64 `efg` payload (`duration_s: 49`).
- Public music attribution parsing was added as best-effort enrichment.

## Instagram provider hardening

Commit:

`5e9e83f75fa19a5f4338ce48399d2a7f828b6d92`

Message:

`refactor(audioflix): harden RESOLVER_PROVIDERS registry architecture and expand regression coverage`

This introduced isolated provider functions and regression coverage for duration parsing, public collection-import fallback, and graceful provider-cascade failure.

## Instagram analysis workflow

File:

`docs/skills/instagram-playwright-analysis/SKILL.md`

Purpose:

- use Playwright/browser automation for discovery and network inspection only;
- identify the actual public request contract;
- reproduce simple contracts with ordinary HTTP where possible;
- independently verify the returned media stream;
- add regression coverage;
- avoid browser automation as an unnecessary runtime dependency.

A previous escape-sequence corruption in this documentation was repaired separately. Do not reintroduce escaped/control characters when editing Markdown.

## YouTube / AudioFlix: existing public path

The mature AudioFlix YouTube resolver already uses a cookie-free path in:

`server_modules/audioflix_ytdl.py`

Its public YouTube player clients are:

`web`, `mweb`, `android`

No `--cookies` / `--cookies-from-browser` requirement is part of the normal direct AudioFlix resolver.

It returns normalized media information such as direct audio URL, title, duration, thumbnail, uploader, and extension.

## YouTube playlist import

File:

`server_modules/audioflix_playlist.py`

Public/unlisted playlist import is intended to work without exported browser cookies.

The importer uses flat extraction so playlist entries are enumerated without resolving every stream up front.

Eve has now explicitly aligned playlist extraction with the same cookie-free client strategy used by the direct AudioFlix YouTube resolver:

`web → mweb → android`

Commit:

`f788ea43127ba90ae74329ae2bec198d2c7169de`

Message:

`docs: add canonical Astro Eve-Branch handoff`

Correction: the playlist implementation itself is the change recorded in that commit; this handoff document was added afterward in commit `16f26359547d3c4f68ed5524e4d85c8bf88d6daa`.

Private/restricted playlists may still legitimately require credentials. Do not attempt to bypass access controls.

## YouTube localization

`server_modules/audioflix_localize.py` reuses the shared AudioFlix yt-dlp loader for localization/downloads.

Normal public localization should remain cookie-free.

## Piano Auto Player

Piano has a more specialized YouTube stack because it must acquire source audio and feed an audio transcription pipeline.

Relevant files include:

- `tools/Piano-Auto-Player/app/audio_transcriber.py`
- `tools/Piano-Auto-Player/app/youtube_access.py`
- `tools/Piano-Auto-Player/web/api.js`

Piano already has:

- anonymous yt-dlp attempts;
- PO-token support via the existing `yt-dlp-getpot-wpc` setup;
- alternate YouTube client attempts;
- browser/session modes as explicit authenticated options;
- diagnostics for bot verification, cookie database problems, decryption failures, and session detection.

Do **not** replace the Piano resolver with the simpler AudioFlix resolver. Piano's source-acquisition flow is specialized for transcription.

### Piano automatic-access policy

Commit:

`4dae8f1c2c59658754ac6c222ec1ced8888da396`

Message:

`fix(piano): make automatic YouTube access anonymous-first`

The web API now normalizes:

`access="auto"` → `access="anonymous"`

Explicit authenticated modes remain available:

- `session`
- `chrome`
- `edge`
- `firefox`

The desired normal UX is:

`public YouTube URL → no cookies required → audio → Piano transcription`

Cookies remain an optional authenticated capability, not a prerequisite.

## Canonical Piano regression video

Use:

`https://www.youtube.com/watch?v=mfUtY5voT5E`

Title:

`Tame Impala - Dracula (8D Audio)`

The final acceptance test must run with **no imported YouTube cookies/session** and prove the full chain:

`YouTube URL`
→ anonymous/provider resolution
→ audio download
→ transcription
→ completed timed Piano performance

Record:

- provider/client that succeeded;
- whether the PO-token provider was used;
- media format;
- title;
- duration;
- transcription completion;
- event count;
- exact failure stage if unsuccessful.

Also add/retain offline regression coverage proving:

- `auto` / Automatic → anonymous-first;
- `anonymous` → anonymous only;
- `session` → explicit session route;
- `chrome` / `edge` / `firefox` → explicit browser-session routes.

## Cross-pollination rules

Use `main` as a mature reference and `Eve-Branch` as the active development line.

Port improvements only when they clearly improve the current architecture.

Useful cross-pollination already identified:

- Piano's richer YouTube diagnostics/dependency detection can inform AudioFlix diagnostics.
- AudioFlix's lightweight public YouTube resolver is useful for library/playback/localization but should not replace Piano's specialized transcription resolver.
- AudioFlix flat playlist enumeration is reusable for future bulk-processing features.
- Instagram's provider registry/fail-safe pattern is a model for future provider registries elsewhere.

Do not create duplicate provider implementations merely to make files look symmetrical.

## What remains to verify

1. Run the canonical Piano public YouTube test with no cookies.
2. Update any stale Piano UI wording that still claims Automatic uses a saved session first.
3. Verify explicit authenticated modes still work unchanged.
4. Verify public YouTube playlist import without cookies.
5. Verify private/restricted playlist behavior fails clearly and does not attempt to bypass access controls.
6. Run relevant AudioFlix and Piano smoke/verification suites.
7. Keep the Instagram resolver architecture unchanged unless a real regression is found.
8. Keep `main` untouched.

## Final reporting requirements

When this pass is complete, report:

- exact files changed;
- exact commit SHA(s);
- public/cookie-free test results;
- authenticated fallback results if tested;
- provider actually used for each canonical test;
- targeted smoke-test results;
- full verification result;
- branch name and HEAD SHA;
- whether working tree/branch is clean;
- confirmation that `main` was not modified.
