# Nexus Phase 3D-B3 — Backend Ownership Seam

## Status

Source-only engineering pass. The seam is implemented and deterministically tested, but it is not constructed by the live Nexus server and cannot invoke TLO. Browser-independent TLO remains disabled.

## Existing owners reused

- Dex `server-durability` remains the only dispatch-admission journal.
- Dex scheduler state remains the authority for request, room, source-message, and final-message correlation.
- `tlo-ownership-fence` remains the durable single-owner/generation fence.
- `tlo-dex-ledger-gate` remains the bridge between Dex admission/final receipts and ownership progress.
- `server-local-relay` remains the existing Local-Origin transport boundary; it now accepts an optional ownership hook.

No scheduler, provider conversation, HTTP route, permission surface, or recovery ledger was duplicated.

## Default-inert behavior

`createServerLocalRelay()` behaves as before when no `tloBackendOwnership` hook is supplied. The live server does not supply one.

Even when explicitly created, `createTloBackendOwnershipSeam()` does nothing unless its server-owned `active` setting is exactly true. An active seam accepts only an exact TLO target whose transport is `tlo-backend-owner`; it rejects the current `search-monitor-workspace` target instead of redirecting a browser-owned conversation.

Before any future backend transport call, the seam requires all of the following:

1. Exact Dex request, turn, room, and source-message correlation.
2. The existing durable Dex ledger already in `dispatching` with exactly one attempt.
3. The configured backend owner and generation matching the durable ownership fence.
4. No ownership handoff in progress.
5. Server-owned proof of durable conversation continuity for the same scope and generation.

The conversation proof includes a digest but not raw history or secrets.

## Failure and recovery rules

- A stale owner, wrong scope, missing history proof, browser transport, or source mismatch stops before provider transport.
- Concurrent work in the same scope is rejected by the ownership fence.
- A transport throw, mismatched event, or return without a final result marks the admitted turn `unknown`.
- An unknown turn survives restart and blocks new dispatch and ownership handoff. It is never retried automatically.
- Final settlement occurs only after the existing scheduler callback has committed both the Dex journal completion and its source-correlated final receipt.
- A completed request cannot be sent again; its single durable dispatch attempt remains authoritative.

## Focused evidence

The B3 regression uses the real durable ownership store, owner fence, Dex turn ledger, server durability adapter, B2 ledger gate, and Local-Origin relay. It covers:

- default-inert browser compatibility;
- authoritative final settlement;
- duplicate and concurrent dispatch rejection;
- stale owner generation;
- browser-transport/reconnect isolation;
- durable conversation proof;
- transport failure and missing-final uncertainty;
- mismatched response request IDs;
- cross-scope isolation;
- restart preservation of unknown work;
- exact source-message correlation.

## Explicitly not proven

- No backend conversation history store exists yet.
- No backend TLO transport target is registered.
- No ownership handoff from the current Search Monitor conversation was attempted.
- No service was restarted and no browser or model was invoked.
- No live browser-closed TLO turn, reconnect, or inference result is claimed.

## Next authorized live step

After review and a separate authorization, implement the durable conversation-history owner and backend transport behind the existing seam. At an idle boundary, prove browser history persistence, acknowledged ownership handoff, exact source identity, one live turn, authoritative receipt settlement, browser reconnect without ownership theft, and fail-closed restart recovery. Keep activation disabled until that acceptance is ready.
