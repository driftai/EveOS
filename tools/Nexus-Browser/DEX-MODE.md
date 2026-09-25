# Dex Mode

Dex Mode is the Nexus Browser's rudimentary multi-agent room layer.

Base Mode remains the existing one-user-to-one-target bridge. Dex Mode sits beside it and reuses the same Online-Origin and Local-Origin transports to let named existing agent sessions exchange messages without the user manually copy/pasting every turn.

## Room model

A room has:

- a room name
- a user display name
- zero or more named agent members
- a persistent transcript mirrored between browser storage and a localhost durable snapshot
- an auto-relay setting
- a bounded relay-turn budget

Each agent member is bound to one specific target chain:

- Online-Origin: provider + concrete browser chat tab, with the chat URL used as the preferred stable identity
- Local-Origin: local target type + concrete local agent target/session

The member's room name is independent of the provider name. A ChatGPT tab can therefore be named `Eve`, an attached Antigravity session can be named `Astro`, and another provider can be given any room identity the user wants.

Human participants can be edited only after selecting **Enable Human Input** on the primary, connected Dex viewer and while the room is stopped. The default Agent-Only Mode instead permits room browsing and human message composition while structural controls remain locked; agent provider-control commands follow separate, exact-room authorization. Editing can change the target class, provider/type, concrete chat/session, and room name without replacing the participant's logical room ID. This is the intended handoff path when a provider conversation reaches a context limit: open the replacement chat, edit the existing participant, point it at the new chat, and save. The room transcript and round-robin identity stay intact while future turns use the replacement target.

Rebinding preserves Dex room continuity, not the provider's private/native conversation memory. A replacement chat receives the normal bounded recent-room context on its next Dex turn, while the full room transcript remains available in the Dex UI.

Dex refuses to bind two different room participants to the same concrete target. If an edited participant's previously bound chat/session is no longer open, the editor requires an explicit replacement selection instead of silently rebinding to the first available target.

User messages render and relay as:

```text
<message>

- From User (<room user name>)
```

Agent messages render and relay as:

```text
<message>

- From <agent room name>
```

Dex attaches these wrappers itself so providers do not need to reliably self-label.

## Relay behavior

Dex intentionally serializes agent turns. Only one Dex provider turn is in flight at a time. This avoids multiple online targets fighting over the extension's existing selected-tab transport and makes room ordering deterministic.

A user message starts with the first member in the room. Each completed agent response is then sent to the next room member in round-robin order. Online targets are selected just before their turn; Local-Origin targets are addressed by their explicit target ID.

Auto relay is bounded by a user-configurable turn budget (default 8, max 500). A stopped room can be continued from its latest message.

Dex control markers are trailing-only and have explicit relay semantics:

- `[[DEX:DONE]]` — record the reply and stop because the room task is complete **and no agent still needs a direct confirmation**. The reply remains readable in the room transcript, but Dex does not send it to another agent as a new turn.
- `[[DEX:USER]]` — record the reply and stop because human input is required.
- `[[DEX:NOTE]]` — record an informational room note and stop the current relay without implying task completion or requiring a user answer.

**Two-agent acknowledgement:** when Eve asks Astro for a reply that Eve must personally receive, Astro replies with the acknowledgement and **no trailing marker**. Dex sends that reply to Eve on the next round-robin turn; Eve verifies the response and then ends with `[[DEX:DONE]]`. For a short handshake set the room budget to **two agent turns** (Astro, then Eve), so the budget still stops the relay if Eve forgets DONE. If Eve only needs the reply preserved in the room for human review and no subsequent agent turn, Astro may end with DONE immediately. Do not explicitly instruct the responder to end with DONE when the objective is a direct agent-to-agent return. In rooms with more than two participants, the next turn follows room order and may not return directly to the requesting agent; use explicit routing or a deliberately ordered room rather than assuming a generic no-marker reply returns to the origin. These instructions clarify existing semantics and do not add a new token or force hidden return turns.

**Opt-in exact-turn RETURN receipt:** to request confirmed delivery of your *own* final reply, append `[[DEX:RETURN:<exact turn ID>]]` at the end, replacing the placeholder with the `Turn ID` in Dex's relay prompt. For example, `Acknowledged. [[DEX:RETURN:dex-turn-9a8c763f-ec15-43b4-833d-da5aac447fb6]]`. Combine with DONE only when no more agent turns are wanted: `Acknowledged. [[DEX:RETURN:<exact turn ID>]] [[DEX:DONE]]`. RETURN alone does **not** change room scheduling, create another agent turn, or turn DONE into a handoff. The exact marker helps the ChatGPT adapter detect a new assistant reply when the new DIL UI no longer exposes the corresponding user prompt. It also allows capture-only recovery to correlate a late result with the exact dispatched request. The extension stores the completed *response* in a bounded persistent outbox, retries only that response over reconnects, and clears it only upon a localhost `dex_turn_receipt` proving the room has durably committed the message. The original prompt is **never replayed** by this feature. No marker can guarantee delivery if the tab disappears before the reply is extracted; the outbox retains expiry and error diagnostics rather than claiming success. Sending RETURN plus DONE still stops before the next participant; to deliver a reply to Astro as an additional turn, use RETURN *without* DONE while the relay is active and has turn budget. During a connection failure or stale renderer, inspect the exact request ID and final-receipt status rather than replaying the old dispatch.

**Opt-in background DONE watch:** an authorized sending agent can attach `"notifyOnDone":true` to its regular `send` command, optionally specifying `"notifyMember":"Astro"`. This arms one bounded, durable watch for that member's next DONE reply; the watcher expires after six hours and is consumed exactly once. Astro may end with DONE normally, and Dex stops the relay normally. The subscribing browser agent receives a separate, out-of-band `[DEX DONE WATCH]` message containing the completion text. **No Dex relay turn is created**, so the room budget and round-robin do not advance, although submitting the notification to the online provider still uses a separate model turn. No extra ACK is sent into Dex merely for receipt. After the ping, the subscription is OFF. The receiving agent may deliberately rearm via `watch_done` or cancel via `unwatch_done`; no automatic continuous surveillance or looping. `watch_done` can be called on its own with an optional exact `member` filter to watch future DONE events without sending a new task. Watcher ownership is tied to the exact authorized room participant. This initial implementation delivers to browser-based Online-Origin agents; a Local-Origin agent attempting to subscribe gets a clear unsupported response. The durable notification record reports pending, confirmed, or failed submission; uncertain deliveries are never retried automatically. The extension must be connected, the target browser tab must be available, and the target must not be handling another active Dex relay turn. A missing tab leaves the event queued. The latest watch state is visible through the room's `status` command.

Dex strips recognized trailing markers before rendering the room message. Mentioning one of the markers in ordinary prose does not trigger it, and unknown `[[DEX:...]]` markers are preserved as normal text.

The control decision is centralized in the Dex protocol instead of being hard-coded throughout the UI controller. That gives future room events (for example async job status, approvals, or provider lifecycle notifications) one place to define whether they continue a conversation, pause for a human, terminate work, or simply land as a non-relayed event.

A repeated-response guard also stops the room if the same normalized agent reply appears repeatedly. The goal is to prevent accidental agent loops and uncontrolled token burn.

## Context policy

Dex does not dump the entire room transcript into every provider turn. It sends a recency-first projected context plus explicit room, message, sender, recipient, and participant identity metadata. The active source message remains unabridged. Prior messages are shortened when necessary, and quoted Dex transport envelopes are collapsed so transport metadata does not recursively consume future prompt context.

This keeps the first implementation understandable and prevents room history from growing into an ever-expanding prompt while the full room transcript remains available in the Dex UI.

## Provider-initiated control

A bound provider can initiate Dex work without waiting for Drift to type the first room message. Browser-provider assistant replies are watched for one structured trailing command marker after generation settles. The supported command surface is deliberately narrow:

```text
[[DEX:CMD {"action":"help"}]]
[[DEX:CMD {"action":"rooms"}]]
[[DEX:CMD {"action":"use_room","room":"<room id or exact name>"}]]
[[DEX:CMD {"action":"status"}]]
[[DEX:CMD {"action":"checkpoint","note":"<goal/completed/blocker/next action/invariants>"}]]
[[DEX:CMD {"action":"read_checkpoint"}]]
[[DEX:CMD {"action":"send","text":"<message>","relay":true}]]
```

Only a trailing marker is executable. Markers inside fenced examples or followed by ordinary prose are ignored. The server does not trust a provider-selected room blindly: an Online-Origin command is authorized only for rooms containing that exact provider/chat binding, and a Local-Origin command is authorized only for an existing exact local target that is already a member of the room. Two different room participants cannot be impersonated through this control plane.

`rooms`, `use_room`, and `status` return a compact tool result to the originating browser provider so it can navigate the rooms it is already authorized to use. A successful `send` is silent by default and records the initiating provider as the room speaker before optionally starting the normal round-robin relay. Provider-control sends are rejected while that room is already relaying so the out-of-band path cannot collide with an in-flight Dex turn.

Extension lifecycle control is separate from local terminal permissions: an exactly bound Online-Origin agent may request `[[DEX:CMD {"action":"reload_extension","room":"<exact authorized room id>"}]]` only while all rooms are idle. The server checks the exact browser session, refuses multiple live extension connections, and returns success only after a reload acknowledgement and a fresh extension/provider-control reconnect. Local-Origin agents and unbound browser chats cannot invoke this operation; no shell access is granted.

Local agents use the same control route through `scripts/dexctl.js`; for example an Existing Session Antigravity process can run `node scripts/dexctl.js rooms --agy-pid <pid>` or `node scripts/dexctl.js send "message" --agy-pid <pid>`. Room state is durably mirrored under `data/runtime/nexus-browser/`. Provider-control requests can still wake a missing headed Dex controller when a browser/local agent needs the room-administration command surface, but relay execution itself is now owned by localhost and does not require a Dex page to remain open.

This control plane is A2A-inspired rather than A2A-compliant: room/member identity remains separate from the command payload, request IDs correlate command results, and asynchronous provider-originated events are routed separately from ordinary conversational history.

## Persistence

Rooms and transcripts remain cached in browser `localStorage` under:

`browser-ai-bridge.dex.rooms.v1`

They are also mirrored atomically to the localhost state store at `data/runtime/nexus-browser/dex-state.json`. Localhost is authoritative for active runtime fields (`relay`, `pendingTurn`, recovery journals, and server-produced messages). A reconnecting viewer cannot overwrite those fields with a stale browser mirror. Interrupted turns are reconciled by the localhost scheduler against the durable turn ledger; if dispatch may have occurred, recovery captures the existing reply without resending the prompt. The Dex page can disappear during this process and later reconnect as a viewer/controller.

Online member bindings prefer exact provider + conversation URL matching when the browser tab ID changes, with the stored tab ID as a fallback. Local session bindings currently use their target ID and may need to be rebound when an underlying process/session identity changes.

## Base Mode isolation

Dex uses a second UI WebSocket client (`clientKind: dex`). Dex request IDs use a `dex-` prefix. The server routing shim prevents Dex response traffic from being mirrored into ordinary Base Mode browser clients. Local Dex replies are likewise kept out of Base Mode browser peers while still allowing local companion consoles to observe their own target traffic.

The browser extension still owns one selected Online-Origin target at a time, so the localhost scheduler temporarily switches that target during serialized online turns. When a relay run finishes, localhost attempts to restore the Online-Origin target that was selected before the relay began. Same-target turns bypass the redundant selection round trip and dispatch directly to the already-selected exact provider tab.

## Design guidance used

Dex is not claiming A2A protocol compliance. Its first envelope borrows several useful ideas from current agent communication work:

- A2A gives conversations/messages explicit context and message identifiers and separates task/message identity from the transport: https://a2a-protocol.org/dev/specification/
- A2A also models interrupted states such as `input-required` rather than assuming every turn can run to completion without the user: https://a2a-protocol.org/dev/specification/
- A2A supports streaming and push-style asynchronous updates for agent work that should not require a human to manually poll or copy messages: https://a2a-protocol.org/latest/topics/streaming-and-async/
- Anthropic's multi-agent engineering guidance emphasizes explicit delegation boundaries and avoiding duplicated work between agents: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic's context-engineering guidance recommends keeping coordinator context focused and using concise/distilled handoffs rather than endlessly carrying every detail forward: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Emerging multi-agent research warns that long-lived peer-to-peer agent coordination without clear structure can produce surprising failure modes; Dex therefore starts with serialized turns, human stop controls, bounded budgets, binding-scoped provider commands, and loop detection: https://www.anthropic.com/research/multiagent-systems

## First qualification target

The first real room should be deliberately small: for example one existing ChatGPT conversation named `Eve` plus one Existing Session Antigravity target named `Astro`.

Verify:

1. Base Mode still works exactly as before when Dex is inactive.
2. The room survives a page refresh but comes back stopped.
3. User messages carry `- From User (<name>)`.
4. Eve's captured response becomes `- From Eve` in the room and is relayed to Astro.
5. Astro's response becomes `- From Astro` and is relayed back to Eve.
6. Only one target is active per Dex turn.
7. Stop relay prevents another turn from being scheduled.
8. Turn budget, `[[DEX:DONE]]`, `[[DEX:USER]]`, `[[DEX:NOTE]]`, and repeated-response guard all terminate correctly.
9. `[[DEX:NOTE]]` records the sender's message, reports a note stop reason, and does not wake the next agent.
10. A stopped participant can be edited onto a replacement online chat/local session while preserving its room ID and existing transcript.
11. Dex replies do not appear as stray responses in the Base Mode transcript.
12. Existing local agent processes are never spawned/replaced merely because they join a Dex room.
13. A bound browser provider can run `rooms`, `status`, and `send` through a trailing `[[DEX:CMD ...]]` without Drift initiating the room turn.
14. An unbound browser chat or fake Local-Origin target is rejected by provider-control authorization.


## Agent room administration

An exact unbound provider chat/session may use `help` and `create_room` only, which safely bootstraps a new room with that exact source as its first participant. After that binding exists, the chat/session can administer only its authorized room(s) through provider control. This is not an Astro-only capability. Bound agents can create/delete/select rooms, rename/configure rooms, add/rename/remove participants, toggle participant relay participation, clear history, stop/continue relay, inspect status/targets, and send room messages. Unbound chats remain denied, structural mutations are blocked while a room is busy, and the final participant cannot be removed without deleting the room.


## Online managed workers

A verified Online-Origin room participant can now delegate by creating fresh browser workers without asking Drift to open tabs or run terminal commands. The parent issues a trailing provider-control action:

```text
[[DEX:CMD {"action":"spawn_agent","room":"<authorized room>","providerId":"muse","name":"Researcher"}]]
```

The same action supports `chatgpt`. Those are the initial spawnable providers because their fresh-chat surfaces have been qualified; other registered providers remain ordinary attachable targets until their new-chat lifecycle is proven.

`spawn_agent` is server-orchestrated rather than browser-UI scheduled. Localhost verifies the exact caller and room, applies mutation dedupe and the global managed-worker bound, asks the extension to create one brand-new `active:false` tab on the provider's canonical fresh-chat URL, waits for the current adapter stack, then applies any provider-declared non-destructive first-turn readiness probe before giving the verified exact tab to the primary Dex controller for durable room binding. The parent's selected provider target is not stolen.

If the provider returns a trailing Dex control command during a relay turn, Dex strips that command from transcript prose and pauses the relay before the control mutation runs. Only the exact participant currently holding that turn gets a short settle-to-idle allowance; structural mutations from other busy-room participants still fail closed.

Managed browser workers are identified by their exact spawned tab ID and carry `managedByDex` in the binding. They may themselves use provider control and can therefore create bounded child workers through the same contract. The current global limit is four committed plus in-flight managed workers.

Managed workers must be removed with:

```text
[[DEX:CMD {"action":"despawn_agent","room":"<authorized room>","member":"<managed member id or exact name>"}]]
```

That removes the participant durably and closes the exact bound provider tab. Ordinary `remove_agent` and room deletion refuse to orphan managed workers. Spawn failures, non-fresh redirects, failed mutation commits, and late uncommitted spawn completions clean up the just-created tab instead of silently leaving it behind.

## Prompt delivery proof

Dex distinguishes **prompt insertion** from **prompt delivery**. Typing relay text into a provider composer is not enough to advance the turn.

Adapters using the shared delivery verifier must prove three stages in order: the exact prompt was seeded into the current composer, one submit side effect was attempted, and a committed user turn containing that prompt appeared in the provider conversation. Composer clearing or text-box departure is recorded as evidence but is not by itself a delivery proof.

Once a submit side effect has been attempted, the adapter may not click, form-submit, or press Enter again for that same dispatch. If commitment cannot be proven, the adapter returns `PROMPT_DELIVERY_UNCOMMITTED`; Dex then preserves exact-once semantics and recovery remains capture/observation-only.

Successful adapter results expose the verified submission mode and delivery proof through `prompt_accepted` so diagnostics can distinguish seeded, attempted, and committed prompt states.

## Durable relay execution

The headed Dex client remains observable, but routine reliability is no longer dependent on one browser tab or a local LLM.

Before each prompt side effect, localhost records the request id in `data/runtime/nexus-browser/dex-turn-ledger.jsonl`. On restart, Dex queries that ledger:

- no ledger entry + reliable ledger => the prompt never crossed the durable dispatch boundary, so replay is safe;
- dispatching/accepted/responding/completed/failed => never replay automatically; recover by capture instead;
- unreliable/uncertain ledger => do not guess; stop replay and record an incident.

Queued-but-not-yet-dispatched work is also durable through `room.pendingTurn`. The localhost scheduler consumes that durable queue directly, so browser-page reloads are no longer part of execution recovery.

Localhost still assigns one connected Dex page the primary **controller** role for room-edit writes. Additional Dex pages are standby and inert for mutations. Losing the primary controller no longer interrupts relay scheduling; another page may be promoted for UI control while the server-owned queue/current-turn/recovery state continues independently.

Known transient failures follow `dex-failure-policy.js`; novel failures are captured as structured incident evidence so a local agent can inspect the exact failure instead of rediscovering room state from scratch.

**Long tool-running ChatGPT turns and DONE reconciliation:** when the current prompt's assistant response consists of visible transient work/status text (for example `Thinking...`), the headed adapter reports that verified status as active `response_activity` approximately every 15 seconds, including while ChatGPT temporarily removes its stop button. This renews the localhost four-minute *idle* lease without lifting the independent thirty-minute absolute ceiling. Ordinary historical assistant text and a silent tab cannot renew the lease. The ChatGPT provider-control watcher also blocks new trailing command dispatch until the response watcher emits its terminal result; localhost still correlates commands to the exact originating turn and fails closed when correlation cannot be proven. If a timeout nevertheless occurs, capture recovery never resends a possibly dispatched prompt. A recovered DONE consumes the same opt-in DONE subscription as an ordinary completion and queues its one-shot notification after the recovered result is committed. Passive expired recovery is not counted as an actively generating turn by the provider-control origin gate, but room mutations remain subject to their own busy/recovery checks. Use the room's recovery state and the turn-lease diagnostics to distinguish *message captured* from *response finalized*; a message visible in the room transcript alone is not proof that the requesting provider received its next turn.


## Agent continuity and restart handoff

Every bound provider or local agent can keep one concise durable checkpoint in its Dex room. This is deliberately provider-neutral: Muse, ChatGPT, Claude, Grok, DeepSeek, Gemini, and Local-Origin agents use the same room-owned checkpoint contract. `onboard` also reads declared provider `agentFeatures`; providers with persistent cloud workspaces/background tasks receive capability-specific guidance without hard-coding provider names.

Use provider control:

```text
[[DEX:CMD {"action":"checkpoint","note":"Goal: ... Completed: ... Blocker: ... Next: ... Invariants: ..."}]]
[[DEX:CMD {"action":"read_checkpoint"}]]
```

Checkpoints are not transcript dumps. They are a small recovery surface for facts that would otherwise cost a long model turn to reconstruct after quota exhaustion, context compaction, a provider-session move, or a local-agent restart. `onboard` and `status` expose the current agent checkpoint when present.

For Local-Origin maintenance agents, run:

```text
npm run handoff
```

The handoff command deterministically reads the durable room snapshot and turn/incident stores, adds the current Git HEAD, uses live localhost diagnostics when available, and emits a compact machine-readable continuation packet. It includes active/pending room state, recovery journals, participant bindings, saved checkpoints, provider blocks, recent bounded context, turn-ledger reliability, the last incident, and one deterministic next-action code.

This removes the need for a restarted maintenance agent to spend a large exploratory turn rediscovering known state.

## Current orchestration ownership boundary

Localhost is now the authoritative Dex execution runtime.

**Server/disk owned:**

- durable room snapshot and deterministic state repair
- live relay queue / `pendingTurn`
- current-turn scheduler state
- round-robin turn selection and relay-budget consumption
- provider-health pre-dispatch blocking
- exact provider-target selection/restoration
- local and online prompt dispatch
- turn timeout and bounded transient retry policy
- durable dispatch ledger and duplicate-dispatch gate
- interrupted-turn capture recovery
- incident history and scheduler diagnostics

**Browser Dex page owned:**

- rendering rooms/transcripts/status
- user room/member/settings edits while allowed
- start/stop/continue control commands
- provider-control command interpretation for the room-administration surface
- a local browser cache used only as a convenience mirror

The browser page no longer owns `state.queue`, `state.turn`, provider selection for relay work, prompt dispatch, timeout handling, or recovery. It does not load the old browser scheduler/recovery modules.

The extension remains the concrete Online-Origin transport adapter and therefore still performs provider-page DOM work. Local-Origin adapters remain process-specific transports. Both sit below the same localhost scheduler boundary.

Open provider tabs are revision-gated. After an extension update, a stale page-side adapter is detected before provider work or Dex tool-result delivery; only that exact stale provider tab is reloaded, the complete registered provider stack is re-probed, and delivery resumes without requiring a manual browser refresh.
