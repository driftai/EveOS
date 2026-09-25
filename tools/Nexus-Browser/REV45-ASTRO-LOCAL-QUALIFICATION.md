# Astro handoff — rev45 ChatGPT stuck-result recovery

**Status:** Remote code is committed; local/runtime qualification is required. This is a temporary handoff, not evidence of a live fix. Keep this document only while this qualification is active.

**Source commit before this documentation-only handoff:** `2ef5490a577adace1620dcedf5562f5f1acaff60`.
**Branch:** `codex/nexus-post-idle-maintenance`. Do not create a new branch, reset or force-push. Preserve the older rollback branch and all independent local commits.

## Current symptom

A read-only Dex `status` result appeared in ChatGPT's composer but was not submitted. The previous local report established deployed adapter **44**, whereas GitHub currently has **45**. Do not assume Astro has pulled/deployed 45 until `git rev-parse HEAD` and an exact-tab `provider_adapter_revision_ping` both prove it. A recent room status also showed **relay stopped but recovery pending on an Eve turn**; re-read current state, never assume that old status is still current. No new Dex send, Enter, duplicate status command or tab reload while an unsent draft or uncertain recovery is present.

## Reconcile in-progress work first

1. Inspect the exact affected browser tab and its composer without changing it; note whether the status-result text is a still-unsent draft and whether a matching *user turn* is already in the conversation. Capture only safe diagnostics (revision, tab binding, text length, send-control metadata, generation state, watcher phase, result-delivery counters); do not paste private transcripts.
2. Use the authoritative localhost turn journal and room status to determine whether the interrupted Eve turn is capture-only, already committed, or still active. Resolve *only a proven passive recovery* using `node scripts/dexctl.js resolve-passive-recovery --room <LIVE_ROOM_ID> --request-id <LIVE_RECOVERY_REQUEST_ID> --reason "Existing reply reconciled; no redispatch"`. Never run this against a live/in-flight turn or as an automatic workaround for a failed message send.
3. Do not reload the exact bound tab while a draft exists. If the already-delivered response needs a manual user action, perform at most one real Send interaction from the actual bound UI only after proving the corresponding message was not submitted. Never synthesize a new Dex command to replace an uncertain one.

## Preserve and qualify the existing branch

From the existing EveOS worktree, run:

```powershell
git status --short
git branch --show-current
git fetch origin
git log --oneline --decorate -4
git merge --ff-only origin/codex/nexus-post-idle-maintenance
git rev-parse HEAD
```

Only run `git merge --ff-only` after confirming that the current branch is the intended existing qualification branch and the worktree is clean. If local commits diverge or the tree is dirty, STOP, preserve the work and send the graph/status to Eve. Do not check out another branch, stash indiscriminately, reset or force.

From `tools/Nexus-Browser` run `node --test tests/chatgpt-answer.test.js tests/chatgpt-input.test.js tests/chatgpt-error-wiring.test.js tests/dex-provider-control-dedup.test.js tests/dex-bound-tab-watchdog.test.js` and then `npm test`. From repository root run `npm run smoke:nexus-browser`, `npm run test:guardrails` and `npm run test:ai-control`. Report exact counts and any failure output.

## Deploy only after global-idle and draft safety

Verify all durable rooms, recovery leases, pending turns and provider-control deliveries are safe. Preserve supervisor and existing agent session. Refresh extension via existing `npm run extension:refresh`; reload only the exact authorized ChatGPT tab with an empty draft and safe room state. Confirm *live* revision 45 on that exact tab after refresh.

Prove exactly one harmless, fully rendered `status` command from the correct active ChatGPT room: show the rendered trailing marker was parsed, localhost acknowledged provider-control ownership, the result reached the content adapter, the current composer was actually submitted, and the result appeared as a ChatGPT **user turn**, not merely text waiting in the composer. If it sticks, collect focused, sanitized composer/form/send-control DOM structure and the adapter's negative ACK/error; **do not auto-resubmit**. A synthetic `KeyboardEvent` is not equivalent to a trusted physical Enter; do not add an unverified retry loop. Return the evidence to Eve for the smallest remote source patch.

After reporting exact locally tested/deployed SHA and runtime evidence, wait for Eve's go-ahead. Do not promote to `main` or delete the rollback/feature branches before accepted live proof and an explicitly verified fast-forward. After acceptance, align `main` non-force to that exact SHA, confirm local/remote parity, and guarded-delete only branches with no independent work/PR/use. Ordinary between-task end state: `main` only.
