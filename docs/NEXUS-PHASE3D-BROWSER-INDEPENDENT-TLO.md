# Phase 3D-A — browser-independent TLO ownership groundwork

## Checkpoint and acceptance status

Baseline for the source-only patch: `eve/nexus-machine-spaces` at
`c172091320c3347b01136602c40718fd1dcec196` (Phase 3C viewer lease).

**Current status: SOURCE-ONLY DURABLE BACKEND CONTRACT — NOT Phase 3D accepted or live-wired.**
Phases B1-B4 now provide durable owner CAS, Dex journal/final-receipt gating, a default-inert
relay seam, bounded durable conversation history, and a composed fake-transport runtime.
The production server still does not register a backend TLO target, and no authenticated
Nexus-to-Python stream transport exists. Running the deterministic tests does not load a
model, create a room, restart any service, or change ignored production runtime data.

## Verified existing owners at baseline

1. `tools/Nexus-Browser/dex/server-scheduler.js` owns Dex turn admission,
   `durability.beforeDispatch`, correlated `requestId`, delivery events and final receipts.
2. `tools/Nexus-Browser/local-targets/eveos-service-chats.js` forwards existing TLO
   messages to `tools/Nexus-Browser/service-workspace-bridge.js`.
3. Search Monitor's `nexusServiceChatBridge.js` is presently a browser-hosted WebSocket
   source of `service_workspace_register`, `service_workspace_partial` and
   `service_workspace_final` messages.
4. `js/modules/gemini/search_monitor/tloChat.js` currently owns bounded browser-memory
   history and invokes `/api/eve-state/modular/tlo/chat/stream` with that history.
5. `server_modules/tlo_chat.py` is already the backend policy/streaming adapter. It reads
   the effective scoped agent projection and selected Local MoE model; its `_ACTIVE` request
   map is **in-memory**, and is not a restart-durable deduplication ledger.
6. The Phase 3C viewer lease disconnects the Dex viewer; it does *not* replace the
   Search Monitor TLO host. Browser independence is not yet achieved.

## Proposed ownership contract

The new `tools/Nexus-Browser/dex/tlo-ownership-fence.js` models one TLO scope's
currently authoritative owner, its monotonically increasing `generation`, a bounded
idle-only handoff and at most one unresolved turn. Identity is `{kind, id, generation}`.
`kind` can be `browser` or `backend`. No host is implicitly claimed.

The fence accepts **only a caller-supplied durable atomic CAS store** (read/revision/
compare-and-swap); it does not open new data files or own a scheduler. The existing Dex
journal remains responsible for globally durable request-ID deduplication and source-to-
receipt correlation. The fence's per-scope `turn` object is only an execution exclusion
and ownership token; it is not a replacement for the existing Dex dispatch journal.

### Handoff states

- Unclaimed -> browser generation 1, only after verified registration/ownership.
- Browser -> prepared -> acknowledged -> backend generation 2, only when idle.
- Reverse handoff requires another idle prepared/acknowledged transfer, raising generation.
- A pending handoff blocks new dispatch.
- An admitted or dispatched turn blocks handoff.
- A transport-uncertain turn remains `unknown`, blocking handoff *and* new dispatch until
  an explicit, evidence-backed reconciliation is implemented.
- Older generations can never be used to reserve or settle a turn.
- A stale CAS revision fails closed, never auto-retries a dispatch.
- A restart with an admitted or dispatched turn conservatively fences it as unknown.

### Future integration requirements — not implemented here

1. **Journal adapter:** Bind the fence to existing Dex durability in an atomic or
   provably serialized boundary. The test-memory adapter is never production authority.
2. **Authentication:** Only the already-authorized browser workspace host and the
   verified localhost TLO backend may claim or acknowledge ownership. Never accept
   arbitrary `workspaceId`, `ownerId`, `generation` or `receiptConfirmed` from a user
   message, remote tab, or an untrusted websocket without server-side verification.
3. **Backend engine:** Reuse `server_modules/tlo_chat.py` and its existing scoped
   projection/model policy. Define a localhost-authenticated entrypoint or equivalent
   ownership-aware adapter. Do **not** bypass `gemini_control` or create an unauthenticated
   network inference endpoint.
4. **History:** Preserve *one* bounded canonical TLO conversation with a verified
   migration boundary; do not silently copy browser history into a second owner.
   The source at baseline has a browser-only `conversation` array.
5. **Dispatch:** Ensure the single backend owner verifies the exact admitted request ID
   and generation at the inference boundary, durably marks dispatch *before* invoking
   upstream FreeToken/Harness, and never retries after an uncertain start.
6. **Legacy browser route:** Fence the existing Search Monitor chat route with the same
   owner token before permitting backend inference; otherwise two active owners remain
   possible. Browser UI becomes an attachable view/control surface after safe migration.
7. **Final receipts:** Connect existing Dex durable final receipts to a trusted
   `settleWithReceipt` call. Untrusted client-provided `confirmed: true` is never evidence.
8. **Restart:** Align the ownership generation and journal with the Nexus service epoch.
   Investigate Python service restart separately; its `_ACTIVE` map is not durable.
9. **Operational readiness:** Stop claiming TLO available merely because the model is
   loaded if no valid owner can accept work. No automatic model boot or service restart.
10. **Stream parity:** Preserve existing SSE, cancellation, capability context and chat
    history contracts. Verify browser `sendWorkspaceMessage` forwards every required
    callback, including capability context, before treating migration as complete.

## Deterministic acceptance gates for later phases

- Browser active -> backend handoff idle, all old-generation work rejected.
- Browser active mid-turn -> handoff blocked.
- Backend is sole inference owner with the main EveOS browser CLOSED.
- Browser reopen -> viewer attachment only, never a second model request.
- Stale heartbeat, concurrent host claim, lost WebSocket, duplicate final and delayed
  callbacks are all fenced.
- Nexus restart and TLO backend restart do not replay a dispatched turn.
- Uncertain requests remain unresolved until existing durable ledger evidence proves
  the outcome; never report inferred success.
- Explicit user approval required before first real browser-closed model test.
- All 14 existing rooms and their Machine Spaces remain unchanged.

## Focused test

```powershell
node --test tools/Nexus-Browser/tests/tlo-ownership-fence.test.js
```

This patch adds a reusable *contract*, not a live-capable backend owner. A passing test
means only the tested reducer/CAS behavior is correct; it is not end-to-end evidence.
