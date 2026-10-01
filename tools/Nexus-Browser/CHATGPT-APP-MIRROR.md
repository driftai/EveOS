# ChatGPT App Mirror

ChatGPT App Mirror is an experimental Nexus Browser transport for binding a specific
ChatGPT conversation used by the desktop app without introducing a private ChatGPT
API or a second ChatGPT adapter.

## Architecture

The mirror uses the exact authenticated web conversation URL as a transport surface:

```text
ChatGPT desktop app
        |
        | same account + server-side conversation
        v
https://chatgpt.com/c/<conversation-id>
        |
        | existing ChatGPT content adapter
        v
EveOS Nexus Browser extension
        |
        v
Nexus localhost / Dex
```

The desktop process is not remotely controlled and Nexus does not inject into native
ChatGPT application windows. Instead, the extension keeps an inactive browser tab
bound to the same conversation. Messages sent by Nexus through that tab should become
part of the same ChatGPT conversation and therefore be visible in the desktop app once
ChatGPT synchronizes the conversation.

The target remains an `online-origin` ChatGPT provider internally so it can reuse the
qualified ChatGPT adapter and Dex exact-target rules. It is visibly distinguished by:

- `targetTypeId: chatgpt-app-mirror`
- `targetTypeName: ChatGPT App Mirror`
- `transport: browser-extension-app-mirror`
- `sessionOrigin: chatgpt-app-mirror`
- `appMirror: true`
- a title prefixed with `[App Mirror]`

A normal ChatGPT browser tab and the App Mirror can coexist as distinct concrete
targets because Dex binds exact tab/url identities.

## First-pass behavior

Base Mode exposes **ChatGPT App Mirror** controls when ChatGPT is selected.

1. Paste an exact `https://chatgpt.com/c/<conversation-id>` URL.
2. Choose **Attach mirror**.
3. Nexus reuses that exact browser conversation if already open, otherwise it opens an
   inactive mirror tab.
4. The mirror is selected as the current ChatGPT target and is published to Dex.
5. Nexus can send through the existing ChatGPT adapter.
6. The mirror performs a lightweight provider-control rescan while idle.

**Sync mirror** performs an explicit hard reload of only the mirror tab. This is the
recovery path when a turn created in the desktop app has reached ChatGPT's server but
has not appeared in the background web DOM yet. Hard sync is refused while the mirror
owns an active Nexus turn.

The first pass deliberately does not hard-reload the conversation on a timer. Repeated
automatic reloads can interrupt generation, duplicate UI transitions, or create the
same catch-up behavior EveOS avoids elsewhere.

## Exact-once protection

The ordinary provider-control bridge already suppresses duplicate commands in memory.
App Mirror adds a second durable guard for accepted Dex commands. The durable key is:

```text
exact conversation URL + ChatGPT assistant turn identity
```

It is not keyed only by browser tab ID, so closing and recreating the mirror tab or
performing a hard sync cannot re-run a previously admitted trailing `[[DEX:CMD ...]]`
from the same assistant turn. The ledger is bounded and expires old entries.

A command is added to the durable ledger only after localhost accepts it. Definite
pre-dispatch failures remain retryable.

## Qualification boundary

Static/unit tests can prove URL validation, exact-tab reuse, background tab creation,
busy hard-sync protection, soft rescans, restoration, extension wiring, UI wiring, and
durable command dedupe.

They cannot prove ChatGPT desktop/web synchronization. That final capability requires
a live test with the authenticated desktop app and browser account.

Recommended live sequence:

1. Attach the exact desktop conversation.
2. From Nexus, send a unique sentence to the mirror and confirm that the new turn
   appears in the desktop app conversation.
3. In the desktop app, produce an assistant reply ending in a harmless Dex command
   such as `status`.
4. If it does not arrive in Nexus automatically, press **Sync mirror** once.
5. Confirm the command is admitted exactly once.
6. Hard-sync again and confirm the same old command is deduplicated.
7. Send a Dex relay turn to the mirror and confirm its final response returns through
   the normal Nexus response pipeline.
8. Keep a normal ChatGPT browser target open at the same time and confirm selecting one
   never routes to the other.

If desktop-created turns do not become visible even after an exact conversation reload,
capture the mirror tab URL, latest visible user/assistant message IDs, provider-control
diagnostics, and Nexus diagnostics before changing transport semantics.
