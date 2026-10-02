# ChatGPT Conversation Sync

Conversation Sync is an optional support capability for the App-Origin **ChatGPT App**
target. It preserves the useful part of the former ChatGPT App Mirror—binding and
rescanning an exact authenticated `https://chatgpt.com/c/<conversation-id>`—without
presenting that browser helper as a second ChatGPT App target.

Normal send/capture remains native Windows UI Automation. Conversation Sync is only for
server-side synchronization/recovery and does not introduce a private ChatGPT API.

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

Conversation Sync itself does not drive the desktop process. Native send/capture is
owned by the App-Origin Windows adapter. The sync helper only keeps an inactive browser
tab bound to the same server-side conversation so Nexus can rescan or hard-refresh that
exact authenticated chat when server/native state needs reconciliation.

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

## First-pass behavior

Base Mode exposes **Conversation sync** controls only while a native ChatGPT App
App-Origin target is selected.

1. Paste an exact `https://chatgpt.com/c/<conversation-id>` URL.
2. Choose **Attach sync**.
3. Nexus reuses that exact browser conversation if already open, otherwise it opens an
   inactive mirror tab.
4. The helper remains hidden from normal Online-Origin and Dex target pickers; the
   selected target stays the native ChatGPT App.
5. Normal Nexus sends continue through App-Origin Windows UI Automation.
6. The helper performs a lightweight provider-control rescan while idle.

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

1. Connect the native ChatGPT App through App-Origin and attach the exact server-side
   conversation URL under **Conversation sync**.
2. Send a unique sentence through the native App-Origin target and confirm the normal
   native round trip remains authoritative.
3. Create a new native turn and confirm the hidden helper sees it after an ordinary
   rescan; if not, press **Sync conversation** once.
4. Confirm any provider-control command discovered through the helper is admitted
   exactly once.
5. Hard-sync again and confirm the same old command is deduplicated.
6. Keep a normal ChatGPT browser target open simultaneously and confirm the hidden sync
   helper never appears as a selectable Online-Origin/Dex target or changes selection.

If desktop-created turns do not become visible even after an exact conversation reload,
capture the mirror tab URL, latest visible user/assistant message IDs, provider-control
diagnostics, and Nexus diagnostics before changing transport semantics.
