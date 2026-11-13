# EveOS documentation — public entry point

This index is the stable, public navigation layer for EveOS source, contributors and the agent-facing development contract. It documents the *product* and safe collaboration interfaces, not a developer's private memory or a live user's state.

## Start here

- [Project overview](../README.md) — what EveOS does and how to start.
- [Development guide](DEVELOPMENT.md) — architecture and implementation conventions.
- [Repository layout](REPOSITORY-LAYOUT.md) — what belongs in Git versus local runtime storage.
- [Shared agent rules](agents/AGENTS.md) — required for **all** contributors, regardless of harness.
- [Cleanup and execution reliability](agents/CLEANUP-RELIABILITY.md) and [Playwright qualification](agents/EVEOS-PLAYWRIGHT-QUALIFICATION.md).
- [Fresh clone](FRESH_CLONE.md), [fresh installation](FRESH-INSTALL.md), and [qualification](SEARCH-MONITOR-RUNTIME-QUALIFICATION.md).
- [Nexus Browser integration](NEXUS-BROWSER-INTEGRATION.md), [TLO / Local MoE integration](LOCAL-MOE-TLO-INTEGRATION.md), and [WatchFusion integration](WATCHFUSION-INTEGRATION.md).

Other dated architecture, incident and qualification notes under `docs/` are **historical evidence**, not automatically current commands. Prefer current source, tests and the active branch; revalidate machine dependencies.

## Agent roles and residency

| Agent | Relationship to EveOS | What the public repository may contain |
| --- | --- | --- |
| **Eve** | Model-independent coordinating and development agent; **ChatGPT is Eve's current brain**, not a permanent provider requirement | Public role, collaboration interfaces and project workflow — **not** private ChatGPT memory, hidden prompts, conversations, credentials or account settings |
| **Nova** | Visiting workstation engineer/validator using Codex | Public repo rules, tested changes, redacted receipts — **not** local `.codex` sessions, `AGENTS.override.md`, settings, transcripts, tool approvals or quota state |
| **Iris** | Visiting engineering agent using Claude Code | Public repo rules and contributions — **not** private Claude instructions, provider sessions, credentials, memory or local state |
| **Astro** | Visiting engineering agent using Gemini CLI | Public repo rules and contributions — **not** private Gemini instructions, provider sessions, credentials, memory or local state |
| **TLO (The Little One)** | **Resident agent inside EveOS**, model-backed through the selected Local MoE provider | Curated public identity/seed, reproducible config/schema and non-secret operational guidance in [`config/agents/tlo/`](../config/agents/tlo/) |

Wren and any other external contributors are also visiting agents unless a separate, deliberate product design changes residency. Merely naming an agent in documentation never grants a runtime capability or tool permission.

**TLO's public definition is not TLO's live inner state.** TLO may be the only intentionally repo-defined *resident agent*, but its actual conversations, generated memories, selected private scopes, session state, provider credentials, permissions and approval records must remain in ignored local EveOS runtime/Agent Management storage. The public `RUNTIME.json` is reproducible startup binding/configuration, never a snapshot of the owner's session or proof a model is running.

## Portable discovery for visitors

- General code agents: [`AGENTS.md`](../AGENTS.md) → [shared rules](agents/AGENTS.md).
- Claude Code / Iris: [`CLAUDE.md`](../CLAUDE.md) → shared rules.
- Gemini CLI / Astro: [`GEMINI.md`](../GEMINI.md) → shared rules.
- Eve/ChatGPT: retrieve the same public documentation from the live repo; private Eve Library workflows are separate.
- Nova/Codex: use shared rules plus local-only `AGENTS.override.md` when available; never copy that override into Git.

No visitor's personal prompt or private harness files are a replacement for product documentation. All contributors follow the same source, security and release controls.

## Publication boundary

**Safe to publish:** reusable source, versioned schemas, synthetic examples, generic instructions, public architectural interfaces, sanitized reports and TLO's reviewed public seed.

**Keep private:** real agent or user messages, room/terminal IDs and transcripts, model memories and personal notes, private agent system prompts, machine usernames or absolute home paths, API keys, cookies/tokens, browser profile data, private music/document libraries, user-selected scopes, access grants, device identifiers and live runtime logs.

Use `$HOME`, `%USERPROFILE%`, `<repo>` or descriptive placeholders in shared instructions. These are portable placeholders, **not** authorization to publish the underlying data. Local loopback ports and generic architecture are okay when necessary, but do not present them as proof of network exposure or deployment state.

Before publication, check both the Git diff and staged/generated artifacts. Scan for secrets and private paths, inspect attachments/screenshots, ensure ignored runtime state is not tracked, then pass the required tests and release gates. `.gitignore` does not remove previously tracked content. Old history is intentionally preserved unless separately authorized security remediation becomes necessary.

**Main-branch discipline:** A public hygiene merge requires the currently qualified development HEAD and a clean local tree, the required exact-head tests, and a non-forced merge/fast-forward with a verified GitHub readback. Do not treat a GitHub-only document edit as proof of local runtime qualification.
