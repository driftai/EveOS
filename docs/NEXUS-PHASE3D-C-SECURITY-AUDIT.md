# Phase 3D-C Security and Ownership Audit

Date: 2026-10-24

Reviewed baseline: `c172091320c3347b01136602c40718fd1dcec196`

Scope: the local Phase 3D-A through B4 source-only delta

## Executive summary

The new ownership, ledger, conversation, and backend-runtime components fail
closed in their focused tests and remain inactive in production. The current
EveOS runtime is therefore unchanged by this checkpoint.

The candidate is **not ready for inactive server registration or live
activation yet**. Registering the backend target without the repairs below
would leave dispatch paths outside the new ownership seam, retain an unfenced
legacy browser owner, and make one important crash window impossible to
reconcile without guessing.

No live service, room, receipt, conversation, or inference state was changed
while producing this audit.

## High-severity release blockers

### P3D-C-001 — Backend inference is not capability-gated at the adapter

Impact: once the backend adapter is registered and active, a server path that
calls the local-target manager directly could invoke TLO without reserving the
durable owner fence or proving exact Dex room/source correlation.

Evidence:

- `tools/Nexus-Browser/dex/server-local-relay.js:24-36` invokes the ownership
  seam only when an optional hook was supplied, then calls the local-target
  manager without passing an unforgeable authorization capability.
- `tools/Nexus-Browser/local-targets/tlo-backend-chat.js:70-96` admits a send
  from public target fields and owner generation alone.
- `tools/Nexus-Browser/server.js:184-207` contains an existing direct
  Local-Origin UI send path that calls `localTargets.sendLocalPrompt()` without
  using `serverLocalRelay`.

Required repair:

1. Mint a one-use, in-memory dispatch capability only after the ownership seam
   reserves the exact request, generation, room, and source message.
2. Require and consume that capability inside the backend adapter before
   `streamChat` can run.
3. Bind it to the selected target transport and the exact request identity.
4. Make activation fail closed if the adapter is enabled without its ownership
   seam and capability issuer.
5. Add a negative test proving the direct UI/local-target path cannot invoke
   the backend transport.

### P3D-C-002 — The browser and backend adapters cannot safely share one target ID yet

Impact: adapter order can either keep the backend target unreachable or route
the shared TLO target through the wrong owner. The old Search Monitor path also
has no durable owner-generation check, so it could remain an inference path
after ownership moves to the backend.

Evidence:

- `tools/Nexus-Browser/local-targets/manager.js:27` registers adapters in a
  fixed order and `manager.js:109-117` selects the first adapter claiming an ID.
- `tools/Nexus-Browser/local-targets/eveos-service-chats.js:35-45` always lists
  and owns `local:tlo-chat:default`.
- `tools/Nexus-Browser/local-targets/tlo-backend-chat.js:30-52` exposes and owns
  the same ID when its separate readiness predicate succeeds.
- `tools/Nexus-Browser/service-workspace-bridge.js:181-250` can send through the
  browser host without consulting the durable TLO owner generation.

Required repair:

Use one composite TLO target owner or an equally strict transport-aware
resolver. Target discovery, status, send, host registration, and final delivery
must all consult the same durable generation. Exactly one transport may be
advertised and dispatch-capable. A stale browser host must be able to attach for
viewing without retaining inference authority.

### P3D-C-003 — A completed inference can lose durable request correlation before Dex delivery

Impact: a crash after the model response is written to conversation history but
before the Dex final receipt is committed leaves the owner turn unresolved,
while the conversation journal no longer records which request produced the
response. Recovery cannot safely prove completion or replay.

Evidence:

- `tools/Nexus-Browser/dex/tlo-conversation-store.js:201-210` appends only
  role/content history and immediately clears `pending`.
- `tools/Nexus-Browser/local-targets/tlo-backend-chat.js:96-100` emits the final
  event only after that journal mutation.
- The authoritative Dex final receipt is committed later by the scheduler
  callback, before the ownership seam settles.

Required repair:

Add a durable `inferred` or `final_pending_delivery` phase containing the exact
request ID, response digest, and bounded response needed for reconciliation.
Clear that phase only after the source-correlated Dex final receipt succeeds.
On restart, preserve it and prohibit replay while allowing deterministic
receipt reconciliation.

### P3D-C-004 — A separately authenticated backend transport does not exist yet

Impact: reusing the current UI stream endpoint would treat generic local UI
authority as backend execution authority and would not bind inference to the
Nexus owner generation or exact dispatch capability.

Evidence:

- `tools/Nexus-Browser/dex/tlo-backend-runtime.js:9-45` accepts an injected
  `streamChat` function but intentionally defines no production transport.
- `server_modules/tlo_chat.py:49-58` authorizes the current route as a local UI
  surface.
- `server_modules/tlo_chat.py:303-384` performs inference without knowledge of
  the Phase 3D owner generation or Dex dispatch capability.

Required repair:

Create a server-to-server transport that authenticates the exact Nexus server
session and binds each request to scope, owner generation, request ID, and a
single-use dispatch capability. Do not broaden or repurpose the browser UI
authorization rule.

## Medium-severity hardening

### P3D-C-005 — Conversation migration proof is self-consistent, not source-authenticated

`tools/Nexus-Browser/dex/tlo-conversation-store.js:146-165` verifies that a
caller-provided digest matches caller-provided history, but the digest is not
bound to the acknowledged ownership handoff. Bind the transcript digest,
source workspace identity, handoff ID, and from/to generations in the durable
handoff record before changing owners.

### P3D-C-006 — Readiness is split across independently evaluated predicates

`tools/Nexus-Browser/local-targets/tlo-backend-chat.js:47-56` checks durable
conversation readiness but not the durable owner fence. The seam and adapter
also evaluate `active` separately. Derive one immutable activation snapshot
from owner state plus conversation proof, and require the dispatch capability
described in P3D-C-001 so a state flip cannot create an unfenced send.

### P3D-C-007 — Partial-stream projection is not bounded

`tools/Nexus-Browser/local-targets/tlo-backend-chat.js:85-92` forwards every
partial value without a length or event-rate bound, while
`server-local-relay.js:32-36` queues each event. Cap projected text, coalesce
updates, and bound queued partial events so a malformed or excessively chatty
transport cannot exhaust memory before the final-response size check.

## Required inactive-integration tests

Before any runtime activation, deterministic tests must prove:

1. Direct UI and direct local-target sends cannot call backend `streamChat`.
2. A capability is one-use and rejects wrong request, room, source, target,
   scope, generation, and expired/replayed use.
3. Backend ownership hides or disables browser inference while preserving
   read-only attachment.
4. Browser ownership hides or disables backend inference.
5. Adapter registration order cannot change the selected TLO owner.
6. A crash after inference but before Dex receipt leaves a correlated,
   non-replayable journal entry that can be reconciled exactly once.
7. Wrong server session, generic loopback clients, stale generations, and UI
   credentials cannot use the backend transport.
8. Restart fencing occurs before the target becomes discoverable.
9. Partial output remains within fixed memory and event-count bounds.

## Gate verdict

- Gate 1 security and ownership audit: **PASS with release blockers found**.
- Gate 2 inactive integration: **BLOCKED** on P3D-C-001 through P3D-C-004.
- Gate 3 scoped activation: **NOT AUTHORIZED / NOT READY**.
- Gate 4 browser-closed acceptance: **NOT READY**.

The safe next change is a source-only repair of P3D-C-001 through P3D-C-004,
followed by the inactive-integration tests above. Runtime activation still
requires separate owner approval.

## Gate 1B remediation (source only)

The reviewable working-tree candidate now resolves the four blockers without
registering or activating the backend runtime:

- **P3D-C-001:** the ownership seam mints an in-memory, one-use capability only
  after exact Dex admission and owner-generation reservation. The backend
  adapter consumes it before journaling or transport; reconstructed, expired,
  mismatched, and replayed capabilities fail closed.
- **P3D-C-002:** the existing service-chat adapter has one exclusive TLO route.
  When a future authorized integration installs the backend route, discovery,
  status, and send all use that route; direct calls still lack the seam's
  capability and cannot infer. The Python browser endpoint also accepts an
  owner predicate and rejects stale browser authority.
- **P3D-C-003:** the durable conversation journal retains the exact request,
  room, source message, dispatch ID, bounded response, and response digest in
  an `inferred` phase. Only a source-correlated Dex final receipt clears it.
  Restart preserves the record and deterministic reconciliation never replays
  inference.
- **P3D-C-004:** a dedicated loopback transport uses a separate HMAC secret,
  exact Nexus session, scope, owner generation, request correlation, content
  digests, timestamp, and one-time nonce. The endpoint is unavailable unless
  an authorizer is explicitly installed; generic UI credentials are rejected.

The handoff record now binds the transcript digest, source workspace, exact
from/to generations, and an authenticated one-time target acknowledgement.
Backend readiness derives from one owner/conversation snapshot, and partial
projection is capped at 128 unique events of at most 32,000 characters.

Focused evidence: the registered Nexus test owner reports 98 Node tests, and
the registered TLO adapter smoke covers backend-auth success, replay rejection,
and generic-UI-credential rejection. Together these cover direct-route bypass,
competing owner routing, capability replay/mismatch/expiry, crash-after-
inference reconciliation, transport authentication, generation-bound handoff,
and bounded streaming. The TLO adapter smoke also covers disabled
backend activation and stale-browser denial. Smoke registry coverage is
465/465 with zero unregistered entry points.

### Updated verdict

- Gate 1B security remediation: **PASS (source-only candidate)**.
- Gate 2 inactive integration: **READY FOR SEPARATE QUALIFICATION**, not yet
  executed or accepted.
- Gate 3 runtime activation: **NOT AUTHORIZED**.
- Gate 4 live browser-closed TLO acceptance: **NOT RUN**.
