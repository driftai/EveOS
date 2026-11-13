# EveOS cleanup and execution reliability — public procedure

This guide applies to all visiting contributors (Eve, Nova, Iris, Astro and others) and to authorized in-project tasks. It is not a personal agent prompt, a current cleanup order, or permission to delete anything.

## Decide and scope

1. Classify the user's request: information, planning, or authorized execution. Execute when the requested action is sufficiently defined and authorized; do not substitute another plan.
2. Name the exact bounded target, owner, repository ref, required state and dependencies. Classify items as reproducible scratch, superseded artifacts, authoritative redacted evidence, unique unpublished source, active application state, or private credentials.
3. Record intended destinations and a cleanup trigger *when creating* a test artifact. User-visible evidence belongs under `$HOME/Downloads/EveOS-Diagnostics` unless the user chooses another destination; tool-managed transient state remains where required.
4. Before destructive action, verify literal resolved paths, containment, reparse points, contents, process ownership and uniqueness against the published source/known snapshots. Avoid wildcard/system-wide purges, guessed app ownership and moving sensitive profiles into shareable Downloads archives.
5. Preserve the sole copy of unpublished work. Preserve current Chrome/Edge and EveOS-owned Spotify profiles, native audio routing, active virtual environments, Git stashes/worktrees and user datasets. Reuse one verified recovery copy only if genuinely needed.
6. Delete **only** items both proven unnecessary and within the user's authorization. Quarantine is a move, not a permanent deletion or reclaimed space. If one item remains ambiguous, retain it and finish other independent authorized work.

## Windows execution-harness diagnosis

An agent may run through a Codex/Claude/Gemini/other host tool. The chain is: **agent request → execution-tool admission → shell/process → Windows permissions/locks → application/runtime → outcome verification**.

- Identify the **first failing boundary** from the exact redacted error. `CreateProcess … rejected: blocked by policy` means the tool rejected a process before PowerShell ran; it is not, by itself, proof of a Windows ACL problem or a missing user approval.
- Prefer the **least powerful legitimate command** for the verified target. On ordinary removable trees, `Remove-Item -LiteralPath <verified-path> -Recurse -ErrorAction Stop` can be sufficient; `-Force` is not always necessary. If a safe read-only/`-WhatIf` comparison is informative, run it once. A preview is not evidence of actual deletion.
- The retired Electron cleanup demonstrated that `-Force` in a preview triggered a Codex prelaunch denial, while a non-`-Force` operation succeeded on an ordinary verified tree. No internal host rule ID was exposed. **This is an observed example, not a universal promise or authorization to bypass policy.**
- If a genuinely necessary operation is forbidden, use supported action-specific approval or stop and report the precise boundary. Do not conceal a prohibited action with another shell, encoding, scheduled task or wrapper. Do not retry identical rejected operations without new evidence.

## Verification and closeout

- Independently check path absence after deletion. Report logical bytes and file counts removed, not just moved/quarantined candidates; distinguish retained essential evidence and remaining uncertain scope.
- Verify any affected service health without restarting unrelated active processes. Record branch and SHA, tests, local/remote status and publication restrictions.
- Keep one redacted receipt; do not store cookies, profiles, login databases, tokens or private agent context in Git or shareable diagnostics.
- When an avoidable problem recurs, improve the smallest shared document or deterministic guard, not another sprawling agent-specific mission log.

Reference: [shared rules](AGENTS.md), [browser profile qualification](EVEOS-PLAYWRIGHT-QUALIFICATION.md), [public docs index](../README.md). Related upstream Codex Windows incident: https://github.com/openai/codex/issues/45403.
