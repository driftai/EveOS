# ChatGPT Windows App-Origin: Codex surface

The Windows ChatGPT desktop process can host more than one conversation surface. The
normal ChatGPT surface exposes explicit role markers such as `You said` and
`ChatGPT said`; the Codex surface may not.

Codex is therefore **not** a separate App-Origin provider. It remains part of the same
`chatgpt-desktop` target and uses the same PID/HWND binding, send path, exact-once
ledger, detach/reattach behavior, and supervisor lifecycle.

## Markerless correlation

When explicit role markers are absent, Nexus uses a prompt-owned markerless reader:

1. Find the exact prompt Nexus injected in the current UIA tree.
2. Inspect only later visible conversation-column content.
3. Ignore workspace chrome, composer placeholders, dates, and timestamps.
4. Treat a later right-aligned message as the next user turn and stop the assistant
   block there.
5. Reconstruct the intervening assistant fragments and assign the same native-turn
   fingerprint format used by the role-marked reader.

If the exact prompt is visible but no assistant block exists yet, the reader remains
correlated and returns an empty response. It must never fall back to unrelated UI text
such as `12:29 AM`.

## Coordinate-frame invariant

Windows UI Automation reports node rectangles in absolute desktop coordinates. A
persisted App-Origin target may contain only PID/HWND/title, while a later `ui inspect`
response may report width/height without repeating the desktop x/y origin. In that case,
relative geometry must use the inspected tree's root `Window` rectangle as the
authoritative frame.

This was proven live on the Codex surface: the ChatGPT window root was at
`x=1392, y=13, 526x844`; the user prompt was around `x=1611, y=198`; and Nova's
reply was around `x=1470, y=299`. Treating the frame origin as `0,0` rejected every
message even though the UIA text nodes themselves were correct.

The regression lives in `tests/chatgpt-windows-frame-origin.test.js`.

## Visual order, not UIA array order

Codex WebView accessibility flattening is not guaranteed to list message nodes in the
same order they appear on screen. Markerless correlation therefore orders eligible
conversation records by their screen rectangle (top-to-bottom, then left-to-right) and
uses message alignment to separate user bubbles from assistant blocks.

The exact injected prompt is the active-send anchor even if its flattened UIA index is
later than the assistant node. A visually lower assistant block may still be the correct
reply and must not be discarded merely because its raw accessibility-array index is
smaller.

## Mixed-surface role-marker rule

The ChatGPT desktop accessibility tree may expose stale or unrelated normal-ChatGPT
role markers while the active conversation is Codex. Global presence of `You said:`
or `ChatGPT said:` must not suppress a Codex reply.

Active correlation therefore uses prompt ownership:

1. an exact role-marked turn for the injected prompt wins;
2. otherwise an exact markerless prompt/reply pair may win even if unrelated role markers
   exist elsewhere in the tree;
3. only after neither reader owns the prompt may global role-marker presence block generic
   fallback capture.

This preserves normal ChatGPT semantics while preventing stale cross-surface markers from
short-circuiting Codex capture.

## Collapsed long-prompt ownership

Long Codex user messages may collapse behind a `Show more` control. In that state the
accessibility tree can expose only a visible prefix of the exact prompt Nexus submitted,
so active correlation must not require byte-for-byte rediscovery of the full prompt.

Prompt ownership remains fail-closed:

1. exact full-text ownership wins whenever available;
2. otherwise, only a sufficiently long visible prefix of the exact submitted prompt may
   own the turn;
3. short/common fragments are never accepted as ownership;
4. `Show more` / `Show less` are UI chrome and never assistant content.

For collapsed prompts, active native-turn identity uses the same observed prompt fragment
that passive markerless reconstruction sees. This keeps active/passive exact-once
fingerprints aligned instead of emitting the same Nova reply twice.

## Long-turn progress filtering

Longer Codex turns may expose temporary accessibility text such as `Working for 5s`,
`Worked for 6s`, or multi-unit variants such as `Working for 3m 24s`. These strings
are generation-status chrome, not assistant content.

The markerless reader filters both ongoing and completed work-duration banners so active
send/capture continues polling until real assistant message content appears. The same
filter applies to passive turn reconstruction so a progress banner cannot become a
native-turn fingerprint.

## Completion-announcement filtering

Codex may expose an accessibility live-region announcement such as
`Response complete: <assistant text>` in addition to the real visible assistant
message node. The markerless reader treats that completion announcement as UI chrome
and keeps the visible reply as the canonical assistant text.

This prevents a completed turn from being reconstructed as
`Response complete: ANSWER ANSWER` when the accessibility tree contains both nodes.

## Thread-title continuity

Codex can virtualize or collapse long prompts enough that the visible conversation-anchor
set rotates between adjacent scans. That must not force an explicit rebind when the
native process/window is unchanged and the same reliable thread title remains visible.

Sidebar controls such as `Show sidebar`, `Hide sidebar`, `Open sidebar`,
`Close sidebar`, and `Toggle sidebar` are UI chrome and are never valid conversation
titles. When a real thread title is available, it may serve as the continuity witness
across anchor rotation on the same PID/HWND.

A different reliable title still fails closed and requires explicit rebind.

## Thread-title chrome rejection

Native conversation identity must never bind to window-management controls. Exact labels
such as `Minimize`, `Maximize`, `Restore`, `Close`, and fullscreen controls are
UI chrome, just like `Show sidebar`.

If the shallow inspect has no reliable thread title, Nexus still runs the deeper title
resolver even when conversation anchors already exist. This matters on Codex because
virtualized history can rotate the visible anchor set; a stable real thread title such
as `Merger Work and Stabilization - Greet` provides continuity without weakening the
explicit-rebind guard for genuine conversation switches.

## Full long-reply reconstruction

Long Codex responses can scroll the submitted prompt and earlier assistant paragraphs above
the visible viewport before generation settles. The final offscreen-inclusive UIA read must
therefore relax both vertical viewport cutoffs. Horizontal conversation-column bounds stay
enforced, but negative/above-viewport and below-viewport y positions are valid during that
one reconstruction pass.

Fast visible polling keeps its normal y-range filter. Only the final
`includeOffscreen=true` reconstruction admits vertically offscreen prompt/reply nodes, so
the adapter can replace a visible tail with the complete prompt-owned assistant block.

The regression in `tests/chatgpt-windows-codex-surface.test.js` covers a prompt plus the
first two Nova paragraphs above the viewport with only the final paragraph visible.

## Monotonic long-turn storage

Active Codex replies are stored monotonically across polling snapshots. A later viewport
slice may extend the stored reply, but it must never shrink or replace earlier assistant
content simply because the user or app scrolled.

The merge rules are:

1. identical or already-contained text is ignored;
2. a larger candidate that contains the stored reply may replace it;
3. overlapping paragraph/character tails are merged without duplication;
4. a genuinely new later slice is appended after the stored content;
5. scrolling back to an earlier slice leaves the stored reply unchanged.

The Base transcript therefore represents the accumulated turn, not the current viewport.
`Capture latest` also merges the live view with the remembered active-turn text instead
of preferring whichever paragraph happens to be visible at that instant.

The default active response deadline is eight minutes so long Codex reasoning plus final
generation is not forced into passive recovery at the old four-minute boundary.

## Long prompt fragment ownership

A long/collapsed Codex user bubble may expose multiple UIA Text nodes. Only the first
node may look strongly right-aligned; wrapped continuation fragments can extend far
enough left to resemble assistant text geometrically.

For active sends, the exact prompt Nexus injected owns every substantial visible UIA
fragment contained inside that prompt. Those fragments are excluded from assistant
capture before geometry classification. This prevents the tail of a long blue user
message from becoming the ChatGPT App reply while preserving the real Nova response
below it.

The regression lives in `tests/chatgpt-windows-codex-long-reply.test.js`.

## Paragraph-boundary reconstruction

Codex can expose visually separate assistant paragraphs as ordinary sibling `Text`
nodes rather than semantic `Paragraph` controls. Markerless capture therefore uses
layout as a secondary structure signal.

Semantic Paragraph/ListItem/Heading nodes always remain block boundaries. For plain Text
siblings, tightly stacked or same-line fragments are joined inline, while a meaningful
vertical gap between nodes aligned in the same assistant column becomes a blank-line
paragraph boundary. A smaller gap is accepted only when the previous block is
sentence-complete; a larger gap is independently sufficient.

This preserves real Nova paragraph spacing without turning ordinary wrapped lines into
separate paragraphs. The captured turn itself carries the `\n\n` boundaries, so Base
Mode, Capture Latest, passive capture, and later Dex consumers all see the same structure.

The regression lives in `tests/chatgpt-windows-codex-long-reply.test.js`.

## Passive turns and identity

The same markerless prompt/assistant pairs feed `completedAssistantTurns()` and
conversation-anchor generation. This keeps active sends, Capture Latest, and passive
native observation on one exact-once identity contract.

The top-level `Codex` workspace selector is UI chrome and must not be treated as a
conversation title. The actual thread heading remains eligible for native conversation
identity.

## Final completeness selection

Codex visible polling may expose clipped or partial Text fragments while a reply is still
growing. Nexus accumulates those fragments for live progress, then compares that monotonic
history with the final offscreen-inclusive prompt-correlated native turn.

The final native turn replaces accumulated progress when it contains the stored reply or
is materially more complete. The accumulated reply remains authoritative when the final
snapshot contains only a shorter visible tail. This prevents both failure modes:

- temporary fragments such as `words.`, `line.`, or truncated tails surviving after a
  fuller native turn becomes available;
- a complete accumulated long reply shrinking to only its last paragraph because the final
  offscreen snapshot virtualized earlier content.

Finalization therefore chooses the more complete prompt-owned representation rather than
blindly preferring either the viewport history or the last UIA snapshot.

## Long-reply tail finalization

Markerless Codex replies can expose a stable visible body before the final tail paragraphs
have reached the accessibility tree. Nexus therefore treats long accumulated replies more
conservatively than short replies:

- four or more reply blocks, or a sufficiently large accumulated body, activates the tail guard;
- the accumulated body must remain quiet for at least 2.5 seconds before final reconstruction;
- if the offscreen-inclusive reconstruction adds text, Nexus emits the larger partial,
  resets the settle window, and resumes polling instead of finalizing in that pass;
- several unchanged long-tail confirmations are required before `response_final`.

This rule is scoped to markerless accumulated replies. Short Codex acknowledgements and
normal role-marked ChatGPT replies keep their existing fast finalization path.

## Timeout recovery

`APP_RESPONSE_TIMEOUT` remains a safety ceiling, not a normal completion signal.
When the deadline is reached, Nexus performs one final offscreen-inclusive,
prompt-owned reconstruction before failing.

If the app is no longer generating and that final snapshot exposes a correlated native
turn for the exact prompt, Nexus finalizes that authoritative turn with
`completenessHint: timeout-recovered` instead of discarding a reply the app already
finished. If generation is still active or no prompt-owned native turn exists, the
timeout remains fail-closed.

This recovery does not add latency to normal replies; it only runs on the path that
would otherwise throw `APP_RESPONSE_TIMEOUT`.

## Qualification

`tests/chatgpt-windows-codex-surface.test.js` covers:

- timestamp rejection;
- prompt-visible/no-reply correlation;
- active Codex send/final capture;
- markerless passive-turn fingerprints;
- markerless conversation anchors.

This test is part of `npm run qualify:app-origin`.
