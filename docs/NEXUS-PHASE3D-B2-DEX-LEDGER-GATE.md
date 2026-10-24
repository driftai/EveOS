# Phase 3D-B2 — Existing Dex journal gate (source-only)

Checkpoint: `eve/nexus-machine-spaces` at `c172091320c3347b01136602c40718fd1dcec196`, plus the six untracked Phase 3D-A/B1 files. This patch adds **three new files only**. No live execution path, server registration, inference, local credentials, service restart, or publication.

The adapter `tools/Nexus-Browser/dex/tlo-dex-ledger-gate.js` is a no-side-effect gate for a future single-owner TLO backend. It reads **the existing Dex `createServerDurability().query()`** and refuses ownership reservation until a TLO-specific `beforeDispatch` has been committed in the existing journal. The caller must supply a trusted server-side exact room/source-message validation callback. It never calls `beforeDispatch` itself, creates a scheduler, sends a request, or fabricates a final receipt.

## Intended production ordering (NOT wired in this stage)

1. Verify scope, current owner generation, original room ID and exact `sourceMessageId` under existing Dex server authorization.
2. Existing Dex `durability.beforeDispatch({type:'send_prompt', requestId}, metadata)` succeeds and records a single `dispatching` admission. Its request ID is the **scheduler turn request ID**, not the user-terminal send ID.
3. Call `reserveAdmitted()` while still holding the relevant existing dispatch boundary. It requires reliable Dex journal status with one matching `local-origin` / `local:tlo-chat:default` / `tlo-chat` reservation.
4. Call `markBeforeTransport()` immediately before sending to TLO; if any step fails, **do not send**. A post-admission failure is not permission to automatically retry, even if upstream dispatch was never observed.
5. Future upstream transport remains owned by the single authenticated TLO host. `markUncertain()` fences lost transport.
6. To settle, require BOTH a `completed` Dex ledger event and an independently verified Dex room final receipt for the exact original source message/turn. `settleAuthoritative()` calls the already-tested fence method only after both confirmations.

## Required integrations still missing

This module is not wired into the Dex scheduler or Search Monitor. No existing production code imports it. Server-side authentication, control-plane ownership generation, durable TLO conversation history and Python-process in-flight persistence still need to be designed and validated before running browser-independent inference. `validateDexSource` and `verifyDexFinalReceipt` MUST be implemented by the trusted, existing Dex server owner with readbacks from its durable room state; never accept UI-provided booleans or claims. The current Dex journal deliberately permits a later `completed` event after some `failed` records: do not treat a failure alone as proof an upstream turn did not run.

The source gate tests use disposable OS temporary directories and the real existing Dex journal implementation. They cannot substitute for a live exactly-once acceptance test. Temporary fixtures are the only filesystem data mutated by tests. No production runtime directory or conversation is touched.

## Qualification

```
node --check tools/Nexus-Browser/dex/tlo-dex-ledger-gate.js
node --test tools/Nexus-Browser/tests/tlo-ownership-fence.test.js tools/Nexus-Browser/tests/tlo-ownership-durable-store.test.js tools/Nexus-Browser/tests/tlo-dex-ledger-gate.test.js
```

Stop on a failing assertion. Do not start Nexus, TLO, or a model, and do not commit or push until all later ownership hooks have been reviewed.
