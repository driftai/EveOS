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
