## Post-refresh observation and exact passive recovery gate (2026-09-25)

Drift reports that after reloading both the extension and the ChatGPT page, **one harmless Dex status result was submitted automatically without a manual Enter**. This establishes one successful headed result-submission observation, but the actual installed adapter revision has **not** yet been measured; it does not prove revision 46 was deployed or caused the success.

The same status response showed room `room-cc282bea-d061-4305-8348-8d549e459b92` with `relayActive:false`, `recoveryPending:true`, `recoveryDispatched:true`, `recoveryInterrupted:true`, and exact `recoveryRequestId:dex-turn-341b2cde-92bd-4d32-ab1f-afd11e046b1b`. Do not resubmit that expired turn or try another out-of-band room send before recovery is safely reconciled.

**Astro-only localhost maintenance:** First inspect the exact room journal and confirm this same recovery is *passive* (timed-out); the scheduler rejects active or wrong-ID requests. From `tools/Nexus-Browser` run this once if passive and idle:

```powershell
node scripts/dexctl.js resolve-passive-recovery --room "room-cc282bea-d061-4305-8348-8d549e459b92" --request-id "dex-turn-341b2cde-92bd-4d32-ab1f-afd11e046b1b" --reason "Timed-out interrupted origin reconciled; no replay"
```

Accept only `RECOVERY_PASSIVE_RESOLVED`; `RECOVERY_NOT_PASSIVE` or `RECOVERY_ROOM_BUSY` means stop and inspect rather than forcing resolution. Recheck authoritative status: `relayActive:false`, `recoveryPending:false`, same original messages, and no new dispatched turn. Do not clear chat, stop another agent, or restart the interrupted command.

**Installed-version proof:** In Nexus extension service-worker DevTools, verify the currently bound Eve tab from the room binding. Then execute `await chrome.tabs.sendMessage(tabId, { type: 'provider_adapter_revision_ping' })` with that exact numeric `tabId`; save `revision` and `ok`. Expected revision **46** for this branch. Revision 45 means only the older browser content has been confirmed, even if the refreshed page auto-submits. Inspect the actual installed `findSendControl` if revision is unclear; don't reset or refresh a draftful tab. The extension service worker's `BrowserAiBridgeDexProviderControlBridge.diagnostics()` may also provide redacted `lastSubmission` mode and failure. Keep the existing temporary branch, do not move main or delete the branch until the local gates, exact-version evidence, safe recovery and accepted live proof have been recorded.

## Current branch implementation (revision 46 candidate)

The bounded form-less Send ownership fix and rejection of synthetic Enter are committed on this same temporary branch. The adapter revision is now 46 so the stale-tab watchdog can distinguish older revision-45 content scripts; this **has not been live deployed or verified**. A later `DEX_CONTROL_ORIGIN_TIMEOUT` occurred when the originating relay failed to finalize within its correlation window. It refused the command; do not resubmit automatically or treat that separate failure as proof about the Send-button patch.

# Dex ChatGPT result sticks in composer — live triage

**Observed:** Drift refreshed the bound ChatGPT tab and issued a harmless Dex `status` command. Dex returned an OK status but the injected `[DEX TOOL RESULT]` draft required Drift to press Enter manually. **This is a failed auto-submit test.** The server-side origin-finalization fix works separately; don't mistake command execution or a seeded draft for submitted delivery.

**Source checkpoint:** Base `main` `701c454f46e4ab0fbe99fd56ce8f8af02df58102`. Temporary aligned branch `eve/dex-result-submission-diagnostics`. The remote patch makes the service worker require a positive `send_prompt` acknowledgement instead of accepting an undefined reply; it also retains redacted `lastSubmission` (request ID, exact tab ID, confirmed mode or failure) beside existing `lastDeliveryError`. It does **not** claim to fix ChatGPT's actual Send button.

## Source fix staged after Astro's live DOM triage

Astro confirmed adapter 45 on exact bound tab 116813186 and the old service worker's error `DEX_RESULT_SUBMISSION_FAILED: ChatGPT Enter submit unconfirmed; draft preserved; no automatic replay.` The **form-less ProseMirror composer** has no enclosing `<form>`; its real `button[data-testid="send-button"]` lives in an outer sibling actions bar several ancestors above the composer, outside the old two-parent search. Consequently the previous adapter found no scoped Send control and used untrusted synthetic Enter. This is evidence from Astro's headed inspection; source-level tests alone cannot establish success on the live app.

The current branch adds a bounded (maximum seven ancestors) composer-owned Send lookup that stops before `document.body` and fails closed on another visible editor, disabled controls or voice/upload controls. Form ownership remains strict. For Dex notifications/results with **no form and no scoped Send**, `chatgpt.js` now refuses synthetic Enter and preserves the draft. Existing exact-once rules still forbid click→form→Enter replay on an uncertain click. The separate service-worker patch requires `ack.ok === true` and logs redacted success mode or error.

**Local qualification and deployment:** Fast-forward only the existing branch if local state is clean. Run `node --test tests/chatgpt-input.test.js tests/dex-provider-control-dedup.test.js`, then uncached Nexus `npm test`, root `npm run smoke:nexus-browser`, guardrails and AI-control. Remote isolated execution passed five new selector/click cases and three result-ACK cases; Windows headed proof is still outstanding. First check global Dex rooms, recoveries, pending controls and every composer draft; never interrupt an active turn. Because the patched content script is already guarded by a once-loaded flag, a **supervised extension reload and safe reload of only the exact bound tab** are needed to activate the changed JS. The branch now declares adapter revision 46 (the prior statement that it was not bumped described an earlier intermediate commit). Verify the **actual bound tab** reports revision 46 and contains the bounded-ancestor selector before attributing a headed result to this repair; a source revision alone is insufficient. If any draft or relay is in flight, do not refresh or test.

**Acceptance:** One *new* harmless status command, once, in a globally idle room; prove exact-origin commit, one provider-control receipt, a positive `send_prompt` acknowledgement (`submissionMode: 'click'`), and a visible committed ChatGPT user turn containing the tool result **without Drift pressing Enter**. If the Send click is unconfirmed, preserve the draft and return sanitized DOM/bridge telemetry rather than replaying. Do not promote `main` or delete the branch until Astro provides this real headed proof and Eve accepts it.

**Separate issue:** `DEX_CONTROL_ORIGIN_TIMEOUT` from relay turn `dex-turn-341b2cde-92bd-4d32-ab1f-afd11e046b1b` is **not** a reason to replay the command. It means Dex could not durably correlate that command to a finalized originating relay turn; inspect authoritative room/recovery state, and resolve only a proven interrupted/passive recovery by exact ID without redispatch. The selector patch fixes the separate ChatGPT *result submission* failure; it does not bypass origin correlation.

## Astro: inspect the existing failure before refreshing or replaying

1. Preserve work and check exact branch/HEAD. Confirm the actual bound Eve tab and room are idle, recovery cleared, no unsent draft. Do not assume an earlier hard-coded tab ID remains correct.
2. Before any extension reload, open **Nexus extension service worker DevTools** and collect:
   `globalThis.BrowserAiBridgeDexProviderControlBridge?.diagnostics()`. Report `deliveriesAttempted`, `deliveriesAccepted`, `deliveriesRejected`, `lastDeliveryError` and the last control request ID. No transcript contents or credentials.
3. In that same extension service worker DevTools, with the currently verified exact tab ID, run the following bounded, read-only inspection. It returns only DOM structure and numeric draft length; it does not click, send or reveal text:

```js
const tabId = /* exact currently bound Eve tab ID */;
const [entry] = await chrome.scripting.executeScript({
  target: { tabId }, world: 'ISOLATED',
  func: () => {
    const api = globalThis.BrowserAiBridgeChatGptInput;
    const composer = api?.findComposer?.();
    const form = composer?.closest?.('form');
    const send = api?.findSendControl?.(composer);
    return {
      revision: globalThis.BrowserAiBridgeProviderAdapterRevision?.ADAPTER_REVISION,
      watcher: globalThis.BrowserAiBridgeDexProviderControlContent?.diagnostics?.(),
      composer: { present: !!composer,
        tag: String(composer?.tagName || ''), editable: !!composer?.isContentEditable,
        connected: composer?.isConnected !== false,
        focused: !!composer && document.activeElement === composer,
        draftLength: api?.composerText?.(composer)?.length || 0,
        formPresent: !!form, requestSubmit: typeof form?.requestSubmit === 'function' },
      send: send ? { id: send.id || '', testId: send.getAttribute('data-testid') || '',
        aria: (send.getAttribute('aria-label') || '').slice(0, 64),
        type: send.getAttribute('type') || '', disabled: !!send.disabled,
        ariaDisabled: send.getAttribute('aria-disabled') || '',
        connected: send.isConnected !== false,
        withinForm: !!form?.contains?.(send) } : null,
      generating: !!api?.generationLooksActive?.()
    };
  }
});
console.log(entry.result);
```

4. If the **existing** failed attempt is still in the browser diagnostics, return that evidence to Eve before another test. Determine which stage failed: no Send button, disabled/foreign Send button, synthetic input not recognized by the app, click unconfirmed despite enabled control, or unacknowledged Chrome message. These are possibilities to investigate, **not established causes**.
5. Run `node --test tests/dex-provider-control-dedup.test.js` on the exact branch, then full Nexus/root gates. Verify no independent dirty work before ff-only. After a globally idle/draft-safe extension refresh, the new background diagnostics will strictly reject a missing/unknown submission ACK. If a new **single** harmless status test is necessary, coordinate it with Eve, capture pre/post sanitized snapshots, and **do not manually press Enter** while collecting failure evidence. An unresolved submission must never trigger a blind click, Enter fallback or duplicate result.
6. Report exact evidence to Eve for the smallest **remote source** correction on this same branch. Do not promote `main` or delete the branch until a headed status result becomes a committed ChatGPT user turn **without human input**. Preserve all previous work and avoid new persistent clones, force pushes and resets.

**Technical limit:** DOM-generated `KeyboardEvent` is untrusted; do not assume synthesizing more Enter events will equal Drift's real keystroke. Avoid requesting invasive debugging permissions without explicit user approval; prefer correcting the actual composer and enabled Send-control path using live evidence.
