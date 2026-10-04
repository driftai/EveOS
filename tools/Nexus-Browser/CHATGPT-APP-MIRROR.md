# ChatGPT Conversation Sync

Conversation Sync is an optional capability for **Online-Origin → ChatGPT**. It
preserves the useful part of the former ChatGPT App Mirror—binding and rescanning an
exact authenticated `https://chatgpt.com/c/<conversation-id>`—without presenting that
background helper tab as another selectable ChatGPT target.

It does not introduce a private ChatGPT API and is independent from native App-Origin
Windows UI Automation.

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

Conversation Sync operates entirely through the browser extension and existing ChatGPT
Online-Origin adapter. The helper keeps an inactive browser tab bound to the exact
server-side conversation so Nexus can rescan or hard-refresh that authenticated chat
without changing the user's selected normal ChatGPT tab. Native App-Origin remains a
separate transport.

The hidden helper tab still reuses the qualified `online-origin` ChatGPT content
adapter internally. However, mirror-decorated tabs are filtered from Base/Dex
Online-Origin pickers, and attaching Conversation Sync no longer selects that browser
tab as the user's active target. Internally it remains distinguished by:

- `targetTypeId: chatgpt-app-mirror`
- `targetTypeName: ChatGPT App Mirror`
- `transport: browser-extension-app-mirror`
- `sessionOrigin: chatgpt-app-mirror`
- `appMirror: true`
- a title prefixed with `[App Mirror]`

A normal ChatGPT browser tab and the App Mirror can coexist as distinct concrete
targets because Dex binds exact tab/url identities.

## UI visibility

Conversation Sync is currently ChatGPT-specific. Its collapsed controls are visible only
for **Online-Origin Targets → ChatGPT**. Switching target type to DeepSeek, Grok,
Gemini, or another provider hides the section immediately. The CSS hidden state is
explicitly authoritative over the shared `.target-row { display: grid }` layout so a
hidden sync section cannot remain painted after a provider switch.

The architecture can later host provider-specific sync helpers for other Online-Origin
providers, but none are exposed until they have their own qualified implementation.

## First-pass behavior

Base Mode exposes the collapsed **Conversation sync** controls only while target class
is **Online-Origin Targets** and target type is **ChatGPT**.

1. Paste an exact `https://chatgpt.com/c/<conversation-id>` URL.
2. Choose **Attach sync**.
3. Nexus reuses that exact browser conversation if already open, otherwise it opens an
   inactive helper tab.
4. The helper remains hidden from normal Online-Origin and Dex target pickers and never
   replaces the selected normal ChatGPT tab.
5. The helper performs a lightweight provider-control rescan while idle.

**Sync conversation** performs an explicit hard reload of only the hidden helper tab. This is the
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

1. Select **Online-Origin Targets → ChatGPT** and attach the exact conversation URL
   under **Conversation sync**.
2. Keep a normal ChatGPT browser target selected and confirm attaching sync does not
   replace it with the hidden helper.
3. Confirm the hidden helper sees the exact conversation after an ordinary rescan; if
   not, press **Sync conversation** once.
4. Confirm any provider-control command discovered through the helper is admitted
   exactly once.
5. Hard-sync again and confirm the same old command is deduplicated.
6. Confirm the hidden helper never appears as a selectable Online-Origin/Dex target.

If desktop-created turns do not become visible even after an exact conversation reload,
capture the mirror tab URL, latest visible user/assistant message IDs, provider-control
diagnostics, and Nexus diagnostics before changing transport semantics.
