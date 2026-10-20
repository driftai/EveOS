# Agent Nexus merger map

This document records the public/private migration boundary for graduating Browser AI Bridge into EveOS as **Nexus Browser** and turning **TLO** into a real Local MoE-backed agent.

## Audited baselines

| System | Audited revision | Role |
| --- | --- | --- |
| EveOS pre-import baseline | `124dd5607b840b3033cadf14161cb7a404d3aa93` | Lifecycle, ports, Search Monitor, shared state contracts |
| Browser-AI-Bridge-POC | `8d61115dae63cf94a2a8a236f727c172e0ca7f99` | Source for browser targeting, Dex orchestration, extension adapters, and reliability contracts |
| Local MoE source snapshot | `6959a6649cac01725095cda60810b96544c09cc7` | Already integrated under `tools/Local-MoE-Harness`; do not merge again |

The Browser POC baseline passed `npm run handoff:verify`. Its public runtime, extension, provider adapters, Dex scheduler, tests, and public operational documentation now live under `tools/Nexus-Browser`. Machine-local state and private engineering notes were not copied. The original POC remains untouched as a comparison source until the integrated runtime passes headed qualification.

## Ownership after the merger

```text
Search Monitor
├── Local MoE Harness       generic local inference provider
└── Agent Nexus
    ├── TLO                 agent identity, context, tools, and chat
    ├── Nexus Browser       browser-target transport and orchestration
    └── Agent Management    private, versioned local agent profiles
```

TLO consumes Local MoE; it does not own FreeToken, model selection, GPU lifecycle, or generic inference. Nexus Browser is a peer tool and must not be renamed to or collapsed into TLO.

## Browser POC classification

| Class | Decision |
| --- | --- |
| Public core | Imported as the isolated `tools/Nexus-Browser` runtime, then adapted to EveOS port, lifecycle, state, UI, security, and verification contracts. Runtime boundaries stay modular rather than being folded into the main web server. |
| Public tests/contracts | Port the exact-once, post-dispatch capture-only, no-focus-steal, adapter-freshness, target-resurrection, room durability, provider-health, and managed-worker tests beside the adapted modules. |
| User/agent data | Leave current rooms, agent identities, chat URLs, messages, and role context in the ignored POC state. Recreate only needed operational context through local Agent Management profiles. |
| Private engineering history | Keep POC handoffs, incident narratives, stress-room material, and obsolete qualification artifacts in Private-Test-Builds unless a generic contract is deliberately rewritten for EveOS. |
| Machine-local state/secrets | Never migrate `.browser-ai-bridge/`, browser/session state, logs, PID files, credentials, local paths, downloads, or authenticated profiles. |

The integrated extension no longer requests `<all_urls>`. Its manifest is restricted to loopback plus the six supported provider origins, and the localhost WebSocket accepts only the extension, the owned runtime origin, or origin-less local Node clients.

## Phase plan

1. **Foundation (complete):** TLO and Nexus Browser appear as distinct Agent Nexus peers. Agent Management v1 persists atomically at `data/runtime/agent-management/agents.json`, keeps a local backup, validates bounded input, and exposes an allowlisted one-agent/one-scope projection. No runtime auto-start is introduced.
2. **TLO chat (complete):** load only TLO's selected scoped projection, connect to an already-running Local MoE Harness through the EveOS TLO adapter, stream/cancel through the existing provider contract, and preserve the no-autostart rule. The browser owns a bounded in-memory transcript; the Harness compact memory remains only a provider optimization.
3. **Nexus Browser runtime (implemented):** the POC server/Dex/extension is an isolated EveOS-owned service on registry port 9088 with verified process identity, explicit start/stop, Global Stop participation, ignored runtime state, an embedded Agent Nexus workspace, and an EveOS-owned unpacked extension source.
4. **Scoped bridge (future EveOS extension):** Agent Management projection is not silently injected into browser chats. A later opt-in bridge must authorize requests by exact room/agent/target and carry only one requested projection. This is not a missing POC feature and is intentionally outside POC-parity deletion criteria.
5. **Qualification (in progress):** deterministic integration gates, live lifecycle/ownership checks, embedded browser geometry, extension reconnection, one disposable provider round trip, stop/Global Stop cleanup, and one final uncached repository verification.

## Agent Management security boundary

- The tracked schema is `config/schemas/agent-management.v1.schema.json`; tracked examples contain fake data only.
- The live store and backup are covered by the existing `data/runtime/` ignore rule.
- The API accepts only loopback localhost EveOS callers (not `file://`/null-origin pages), caps request bodies, validates IDs/types/lengths, and writes atomically.
- Full profiles are available only to the local management UI. Browser-facing consumers use `/api/eve-state/modular/agent-management/projection` with one explicit `agentId` and `scopeId`.
- Projections omit private notes, permissions, provenance, unrelated scopes, and every other agent.
- Future schema versions must add an explicit idempotent migration and rollback test; unsupported versions fail closed.

## TLO chat boundary

`TLO UI -> /api/eve-state/modular/tlo/chat/stream -> tlo/default projection -> Local MoE /api/chat/stream`

- EveOS assembles the system prompt only from the scoped projection's display name, role, identity, working rules, allowed-tool capability context, scope instructions, scope context, and scope tools.
- Private notes, permissions, provenance, other scopes, and other agents never enter the TLO adapter payload.
- An empty TLO `modelId` uses the running Harness selection. A configured ID must exist in the trusted Harness registry and already be active; TLO never accepts model paths, launch flags, or silent model switches.
- The browser transcript is private and page-local. Clear/new conversation resets it without changing Agent Management. Transcript persistence is deliberately deferred until a distinct local conversation owner is justified.
- Opening TLO performs only passive status reads. Start, stop, setup, and model switching remain in the generic Local MoE surface.

## Phase 2 qualification

Phase 2 completed its native-Windows qualification on 2026-09-20 with the trusted `bonsai2-27b-ptq1` registry model. The stopped surface remained navigable and did not start Local MoE. After an explicit start, TLO streamed a first turn, recalled a unique token on the second turn, cancelled an in-flight long response, and returned to an idle request count without spawning duplicate Harness or model processes. Local MoE then stopped cleanly, and the ignored Agent Management TLO profile survived the EveOS web-server restart while its scoped projection continued to exclude private fields.

Nexus Browser remains a peer of TLO. It does not receive TLO's private profile, filesystem access, credentials, or unrelated Agent Management data. See `docs/NEXUS-BROWSER-INTEGRATION.md` for the integrated ownership map, runtime paths, verification commands, and delete-readiness boundary.

## Repeatable acceptance

Run the focused Agent Nexus and Agent Management contract from a clean committed
candidate with:

```powershell
npm run --silent qualify:agent-nexus-acceptance -- --profile focused --expected-head <40-character-SHA>
```

Use `--profile ai-control` for the focused checks plus the affected AI-control
profile. Use `--profile release` only for the final candidate; it adds the full
41-obligation release qualification. The driver fails fast, keeps successful
terminal output to one line, saves bounded structured evidence under
`data/runtime/smoke-results/agent-nexus-acceptance-<profile>.json`, and verifies
that the Phase 3 ledger and recovery guide remain byte-identical during the run.

The Playwright smoke covers the normal `file://` EveOS shell with its trusted
localhost Agent Management iframe, private saves, iframe reload persistence,
desktop and narrow geometry, focus preservation, request counts, and failure
artifacts. Backend persistence, stale-revision rejection, input validation and
new-turn context assembly remain asserted by the isolated Python contract rather
than being inferred from browser pixels.
