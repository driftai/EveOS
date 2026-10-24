# Nexus Phase 3D-B4 — Durable Backend Runtime (Source Only)

## Status

Implemented and deterministically qualified as a default-disabled source composition. It is not registered in the live Nexus server, has no concrete Python/model transport, and does not make browser-independent TLO operational.

## Added owners

- `tlo-dex-state-authority.js` supplies B2's trusted callbacks from the existing Dex state store. It accepts either the exact active recovery journal or the exact source-correlated final receipt and never mutates room state.
- `tlo-conversation-store.js` owns one bounded durable conversation per scope. It uses an exclusive local filesystem lock, atomic fsync/rename writes, exact owner generation, a maximum of 40 normalized messages, and explicit prepared/dispatched/unknown turn states.
- `tlo-backend-chat.js` adapts an injected stream transport to the existing Local-Origin target contract. It exposes no target while disabled and never implements HTTP or model access itself.
- `tlo-backend-runtime.js` composes the existing ownership store/fence, Dex journal gate, trusted state authority, B3 relay seam, durable conversation store, and backend target adapter.

## Dispatch ordering

The source integration proves this order:

1. Existing Dex scheduler admission commits `dispatching` once.
2. Existing recovery state proves exact room, member, source message, target, and provider.
3. Ownership seam reserves the exact backend owner generation and marks the turn dispatched.
4. Conversation journal records the user message as prepared, then dispatched, before the injected transport is invoked.
5. Transport output is persisted to bounded conversation history before its final event is emitted.
6. Existing Dex handling commits its completed journal event and source-correlated final receipt.
7. B2 verifies those existing owners and clears the ownership turn.

Any uncertain failure keeps both execution ownership and conversation state blocked as `unknown`. No component automatically changes the request ID, removes a lock, clears uncertainty, or replays inference.

## History handoff

Browser history must be normalized and initialized with its exact SHA-256 digest. Initialization is one-shot. An idle handoff advances exactly one owner generation only if the prior generation's digest still matches and no conversation turn is unresolved. The backend target stays unavailable until durable history proof matches its owner generation.

This is the persistence contract only. The existing Search Monitor browser currently keeps history in memory and does not export it to this store.

## Security boundary

- No new HTTP endpoint or localhost permission was added.
- No bearer token, credential, prompt, or response enters the ownership journal.
- Conversation text is stored only in the ignored Nexus runtime directory when a future authorized caller constructs the store with its default path.
- Current browser transport remains authoritative and unchanged because the live server does not construct or register the backend runtime.
- An exact TLO target bound to a different provider, transport, scope, or generation fails before transport.

## Focused evidence

- Trusted Dex state authority: 7 tests.
- Durable conversation history and recovery: 12 tests.
- Default-inert backend target adapter: 7 tests.
- Full fake-transport composition: 3 tests.

The composition test uses the real ownership store, owner fence, Dex turn ledger, server durability, final-receipt authority, conversation store, B3 relay seam, and backend adapter. It performs no network request or inference.

## Still required before live activation

1. Add a separately authenticated Nexus-to-EveOS TLO stream transport; do not rely solely on generic loopback origin checks.
2. Persist and migrate the current Search Monitor history at an acknowledged idle boundary.
3. Fence the legacy browser inference route with the same durable owner generation before backend activation.
4. Register exactly one TLO target owner at a time; never list browser and backend targets with the same ID concurrently.
5. Wire explicit boot-time restart fencing and evidence-backed uncertain-result reconciliation.
6. Run one separately authorized browser-closed live turn, browser reconnect/view attachment, cancellation, Nexus restart, and Python service interruption acceptance.

Until those boundaries are implemented and accepted, `active` must remain false and no production server registration should be added.
