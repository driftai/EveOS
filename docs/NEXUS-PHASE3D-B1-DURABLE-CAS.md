# Phase 3D-B1 — durable ownership CAS, source-only

Checkpoint: `eve/nexus-machine-spaces` at `c172091320c3347b01136602c40718fd1dcec196`, plus the three untracked Phase 3D-A source files. This overlay deliberately creates **only three additional files**. Do not promote this stage as a live TLO or browser-independent acceptance.

## Scope

- `tools/Nexus-Browser/dex/tlo-ownership-durable-store.js`: filesystem-backed, synchronous per-scope compare-and-swap adapter for the existing `tlo-ownership-fence.js` contract. It has no server or model call site. Merely importing it creates no file.
- `tools/Nexus-Browser/tests/tlo-ownership-durable-store.test.js`: deterministic temporary-directory tests for persistence, revision races, retained lock conflict, browser/backend idle handoff across store instances, unknown-turn restart fence, corrupt/symlinked file rejection and scope isolation.
- This document records the intended authority and known limitations. It introduces no data migration.

### Storage

The default store directory when instantiated without an override is the *existing* Nexus Browser runtime data root (from `runtime-config.dataDir()`), under `tlo-ownership/`. The installer/test suite **never** instantiate that default path. Tests use disposable OS temp directories and remove only their own fixtures.

Records contain fence metadata (`owner`, `generation`, `handoff`, `turn`), but no conversation transcript, prompt, final reply, provider credentials, or tokens.

The CAS operation exclusively creates `<scope>.lock` with filesystem `mkdir`; a competing writer fails closed. Under this lock it re-reads the exact UUID revision and atomically replaces the record using a unique temporary file, `fsync` on the file, and rename. A crash leaving the lock behind intentionally blocks additional writers. **Never automatically delete or expire an ambiguous lock**; a later operator must establish why it remains.

The lock and revision serialize ownership updates on a conventional local filesystem. This is not a distributed database or a guarantee against power-loss failure, network-filesystem inconsistencies, privileged tampering, or Windows ACL misconfiguration. Before production, validate local-only storage permissions and Windows-specific rename/ACL behavior.

## Not implemented at B1

- No connection to Dex `server-durability`, `turn-ledger`, `service-workspace-bridge` or the TLO inference endpoint.
- No authenticated browser claim, backend owner attestation, validated handoff acknowledgment, service ownership lifecycle, or server-side conversation history.
- No boot-time `fenceRestart` hook or caller to reconcile an unknown turn with a *trusted* Dex final receipt.
- No model request, runtime restart, browser action, new Dex room, publication, or permission grant.

**Important:** The underlying Python `server_modules/tlo_chat.py` holds its `_ACTIVE` request map in memory, and `tloChat.js` holds transcript history in browser memory. Persisting the ownership token does **not** migrate those behaviors or establish cross-process exactly-once inference.

## Next boundary

B2 must add an authenticated server-owned registration/generation authority, bound to the existing Dex scheduler's `beforeDispatch` journal and a single canonical conversation owner. Legacy browser inference must be fenced before enabling backend routing; neither path can be active at the same time. The source-only store must remain unused until a safe orchestrated migration can be established.

## Focused validation

```powershell
node --check tools/Nexus-Browser/dex/tlo-ownership-durable-store.js
node --test tools/Nexus-Browser/tests/tlo-ownership-fence.test.js tools/Nexus-Browser/tests/tlo-ownership-durable-store.test.js
```

Expected: **24/24**; no inference, runtime state changes, or service restarts. New files should remain untracked pending review.
