# Phase 3D-C Gate 2 — Inactive Integration Qualification

Date: 2026-10-24

Baseline: `c172091320c3347b01136602c40718fd1dcec196`

Runtime boundary: isolated temporary ownership, conversation, and Dex ledgers;
backend inference disabled; no service restart, model request, browser automation,
room mutation, deployment, commit, or push.

## Verdict

**PASS — GO for a separately authorized, guarded Gate 3 activation.**

This is not authorization to activate the backend. Gate 3 must retain exact
source identity, rollback, credential provisioning, and one-turn limits.

## Integration scenarios

1. **Registration and routing — PASS.** Both browser-first and backend-route-
   first registration expose no duplicate TLO target. A direct send while the
   backend is disabled is rejected before transport, with no browser fallback.
2. **Startup reconciliation — PASS.** Fresh runtime construction fences an
   interrupted owner turn as uncertain. An inferred response without a source-
   correlated final receipt remains non-replayable. Corrupt ownership state
   fails diagnostics closed and exposes no target.
3. **Ownership transitions — PASS.** Browser generation 1 hands off to backend
   generation 2 and back to browser generation 3 without changing transcript
   ordering. Stale owners fail. Target acknowledgement is one-use, transcript-
   bound, and expires after the bounded handoff window.
4. **Transport authentication — PASS.** Dedicated HMAC authorization accepts
   the exact configured session once and rejects replay, generic UI credentials,
   stale timestamps, wrong scope, wrong generation, and request mismatch.
   Secrets and signatures are absent from diagnostics.
5. **Conversation continuity — PASS.** Synthetic history stays ordered and
   bounded; inferred state retains request/room/source/dispatch correlation;
   exact delivery settles once; late duplicate delivery is rejected.
6. **Disabled inference — PASS.** All exercised backend entrypoints safely
   refuse while disabled. The fake model transport call count remains zero.
7. **Readiness — PASS.** Unified diagnostics distinguish browser-owned,
   transferring, backend-disabled, backend-owned/ready, uncertain, busy/history-
   unavailable, and owner-unavailable states without premature readiness.

## Evidence

- Full Phase 3D deterministic Node matrix: **105/105 PASS**.
- Registered TLO adapter/authentication smoke: **PASS**.
- Gate 2 integration scenarios: **7/7 PASS**.
- Production backend activation: **unchanged and disabled**.
- Real Dex rooms and runtime data: **untouched**.

## Gate 2 changes

- `tools/Nexus-Browser/dex/tlo-ownership-fence.js`
- `tools/Nexus-Browser/dex/tlo-backend-runtime.js`
- `tools/Nexus-Browser/local-targets/tlo-backend-chat.js`
- `tools/Nexus-Browser/tests/tlo-inactive-integration.test.js`
- `tools/smoke/tlo_chat_adapter_smoke.py`
- this report

## Remaining Gate 3 risks

- Production registration and secret/config lifecycle are intentionally absent.
- Real process restart and rollback have not been exercised.
- No real Local MoE/TLO inference, cancellation, or browser-closed turn has run.
- Gate 3 must prove exact source identity and one active owner before allowing
  one bounded live request; any uncertain result must stop without replay.
