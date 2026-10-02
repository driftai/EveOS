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

## Passive turns and identity

The same markerless prompt/assistant pairs feed `completedAssistantTurns()` and
conversation-anchor generation. This keeps active sends, Capture Latest, and passive
native observation on one exact-once identity contract.

The top-level `Codex` workspace selector is UI chrome and must not be treated as a
conversation title. The actual thread heading remains eligible for native conversation
identity.

## Qualification

`tests/chatgpt-windows-codex-surface.test.js` covers:

- timestamp rejection;
- prompt-visible/no-reply correlation;
- active Codex send/final capture;
- markerless passive-turn fingerprints;
- markerless conversation anchors.

This test is part of `npm run qualify:app-origin`.
