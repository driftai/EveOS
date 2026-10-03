/**
 * gemini_mode2_context_routing_smoke.js
 *
 * Mode 2 as the default conversation mode + the Context Relay routing to the Text Brain:
 *   1. State migration: pre-default saves carrying 'direct-live' (the OLD default) flip to
 *      Mode 2 once; an explicit post-migration 'direct-live' choice is respected.
 *   2. In Mode 2, "Send Selected Context" hands the snapshot to the text brain slot (1M-token
 *      model, 200k-char budget) — the live session's WebSocket gets NOTHING.
 *   3. The next Mode 2 turn carries the snapshot to the backend and the brain's reply is
 *      relayed to the live model.
 *   4. Mode 1 still routes context over the live WebSocket (regression).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');

function runScript(context, relativePath) {
    vm.runInNewContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
}
// state.js installs its group/folder editors from a sibling module at load, so preload it first.
function loadState(context) {
    runScript(context, 'js/modules/features/audioflix/audioflix.state.schema.js');
    runScript(context, 'js/modules/features/audioflix/audioflix.state.groups.js');
    runScript(context, 'js/modules/features/audioflix/audioflix.state.recovery.js')
    runScript(context, 'js/modules/features/audioflix/audioflix.state.js');
}
function assert(condition, message) { if (!condition) throw new Error('ASSERT FAILED: ' + message); }

// Big dummy pack (Nova pattern): full tier builds ~478k chars -> must ladder under the 200k budget.
const LONG_NOTE = ('This is an intentionally long note describing the card in detail. ').repeat(12);
function makeLinks(n) {
    const links = [];
    for (let i = 0; i < n; i += 1) {
        links.push({
            id: 'k' + i, title: 'Card ' + i, workspace: 'main', category: 'Test',
            url: 'https://example.test/series/' + i + '?utm_source=x&ref=' + 'r'.repeat(90),
            notes: 'Card ' + i + ': ' + LONG_NOTE,
            tags: Array.from({ length: 18 }, (_, t) => 'tag' + t),
            genre: Array.from({ length: 18 }, (_, g) => 'genre' + g),
            relatedUrls: Array.from({ length: 8 }, (_, r) => ({ url: 'https://mirror' + r + '.test/' + i + '/' + 'p'.repeat(120) })),
            priority: 'High', chapter: String(i), identifiers: ['listening'],
            summary: LONG_NOTE, description: LONG_NOTE
        });
    }
    return links;
}

function makeStateVm(storedState) {
    const stores = { eveAudioflixFallbackState: storedState ? JSON.stringify(storedState) : null };
    const context = {
        console, Date, JSON, Math, Object, Array, String, Number, Boolean,
        localStorage: {
            getItem: (k) => (k in stores ? stores[k] : null),
            setItem: (k, v) => { stores[k] = String(v); },
            removeItem: (k) => { delete stores[k]; }
        },
        setTimeout, clearTimeout,
        window: { dispatchEvent() {}, addEventListener() {} },
        CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; }
    };
    context.window.window = context.window;
    context.window.localStorage = context.localStorage;
    context.window.CustomEvent = context.CustomEvent;
    return context;
}

function makeRelayVm({ textBrainMode }) {
    const wsFrames = [];
    const brainRequests = [];
    const spoken = [];
    let messageListener = null;
    const ws = {
        readyState: 1,
        addEventListener(type, fn) { if (type === 'message') messageListener = fn; },
        send(payload) {
            const data = JSON.parse(payload);
            if (data.type === 'text_brain_request') {
                brainRequests.push(data);
                // Backend echo: answer immediately so relayUserUtterance resolves.
                messageListener({ data: JSON.stringify({ type: 'text_brain_response', requestId: data.requestId, text: 'Brain reply about your cards.', usage: { prompt: 10, output: 5, total: 15 } }) });
            } else {
                wsFrames.push(data);
            }
        }
    };
    const context = {
        console, Date, JSON, URLSearchParams, URL, setTimeout, clearTimeout,
        WebSocket: { OPEN: 1 },
        navigator: {},
        window: {
            localStorage: { getItem: () => null },
            config: {
                activeWorkspace: 'main',
                geminiLiveLinkEnabled: true,
                geminiContextDataStreamEnabled: true,
                workspaces: [{ id: 'main', name: 'Main', subTabs: [] }]
            },
            EveAudioflixState: { isTextBrainMode: () => textBrainMode },
            EveDataStore: {
                _modularSync: {
                    sharedReady: true, engineReady: true,
                    isHttpContext: () => false,
                    getStore: () => ({
                        captureState: () => ({
                            metadata: { version: 1 },
                            bookmarks: {
                                config: { activeWorkspace: 'main', workspaces: [{ id: 'main', name: 'Main', subTabs: [] }], bookmarkIdentifiers: [] },
                                links: makeLinks(110), folders: {}, pins: []
                            },
                            library: { categories: {}, connections: [] }
                        })
                    }),
                    requestJson: async () => { throw new Error('file:// mode'); }
                }
            },
            webSocket: ws,
            WebSocket: { OPEN: 1 },
            sendTextMessage: (text) => spoken.push(text),
            displayMessage() {},
            dispatchEvent() {},
            CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; }
        }
    };
    context.window.window = context.window;
    context.CustomEvent = context.window.CustomEvent;
    return { context, wsFrames, brainRequests, spoken };
}

(async function main() {
    // --- 1. State default + one-time migration ---
    {
        const oldSave = makeStateVm({ geminiConversationMode: 'direct-live' });   // pre-default save, no flag
        loadState(oldSave);
        const migrated = oldSave.window.EveAudioflixState.ensure();
        assert(migrated.geminiConversationMode === 'text-brain-live-voice', 'old direct-live save should migrate to Mode 2');
        assert(migrated.geminiModeDefaultV2Applied === true, 'migration flag should be set');

        const explicit = makeStateVm({ geminiConversationMode: 'direct-live', geminiModeDefaultV2Applied: true });
        loadState(explicit);
        assert(explicit.window.EveAudioflixState.ensure().geminiConversationMode === 'direct-live',
            'explicit post-migration direct-live choice must be respected');

        const fresh = makeStateVm(null);
        loadState(fresh);
        const freshState = fresh.window.EveAudioflixState.ensure();
        assert(freshState.geminiConversationMode === 'text-brain-live-voice',
            'fresh state should default to Mode 2');
        assert(freshState.nativeBridgeEnabled === false && freshState.nativeSuppressBrowserPlayback === false,
            'fresh state should use audible browser/system playback without a native route');

        const legacyNative = makeStateVm({
            routeMode: 'native-bridge', nativeBridgeEnabled: true,
            nativeOutputId: 'legacy-cable', nativeSuppressBrowserPlayback: true,
            preferredSinkId: 'legacy-browser-cable', preferredSinkLabel: 'CABLE Input', geminiVoicePortEnabled: true
        });
        loadState(legacyNative);
        const safeRoute = legacyNative.window.EveAudioflixState.ensure();
        assert(safeRoute.nativeRouteDefaultV2Applied === true && safeRoute.nativeBridgeEnabled === false
            && safeRoute.nativeSuppressBrowserPlayback === false && safeRoute.routeMode === 'browser'
            && !safeRoute.preferredSinkId && safeRoute.geminiVoicePortEnabled === false,
        'legacy implicit native-only state should migrate once to audible browser/system playback');

        const explicitNative = makeStateVm({
            nativeRouteDefaultV2Applied: true, routeMode: 'native-bridge', nativeBridgeEnabled: true,
            nativeOutputId: 'explicit-cable', nativeSuppressBrowserPlayback: true
        });
        loadState(explicitNative);
        const retainedRoute = explicitNative.window.EveAudioflixState.ensure();
        assert(retainedRoute.nativeBridgeEnabled === true && retainedRoute.nativeSuppressBrowserPlayback === true,
            'an explicit post-migration native route must remain enabled');
        if (process.env.EVE_SMOKE_VERBOSE === '1') console.log('state default + migration OK');
    }

    // --- 2. Mode 2 module race: never leak scoped context to the Live socket while Text Brain loads ---
    {
        const { context, wsFrames } = makeRelayVm({ textBrainMode: true });
        for (const script of [
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.shared.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.scope.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.bookmarks.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.nexus.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.sync.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.scope.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.transport.js',
            'js/modules/features/modular-state-sync/modular-state-sync.api.context.js'
        ]) runScript(context, script);

        let handedOff = '';
        setTimeout(() => {
            context.window.EveGeminiMode2 = {
                setEveContext(message) { handedOff = message; return { chars: message.length }; }
            };
        }, 20);
        const result = await context.window.EveDataStore._modularSync.sendContextToGemini('summary', 10);
        assert(result.ok && result.route === 'text-brain', 'delayed Mode 2 slot should receive context');
        assert(handedOff.includes('[SYSTEM CONTEXT:'), 'delayed Mode 2 slot received the scoped snapshot');
        assert(wsFrames.length === 0, 'Mode 2 loading race must never leak context to the Live socket');
        if (process.env.EVE_SMOKE_VERBOSE === '1') console.log('mode 2 delayed-slot routing OK');
    }

    // --- 3 + 4. Mode 2: context routes to the text brain; next turn carries it ---
    {
        const { context, wsFrames, brainRequests, spoken } = makeRelayVm({ textBrainMode: true });
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.shared.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.scope.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.bookmarks.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.nexus.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.sync.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.scope.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.transport.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.js');
        runScript(context, 'js/modules/gemini/mode2/textBrainRelay.config.js');
        runScript(context, 'js/modules/gemini/client/usageTelemetry.js');
        runScript(context, 'js/modules/gemini/mode2/textBrainRelay.js');
        const api = context.window.EveDataStore._modularSync;
        const mode2 = context.window.EveGeminiMode2;

        const result = await api.sendContextToGemini('full', 90);
        assert(result.ok && result.sent, 'mode 2 context send failed: ' + (result.error || ''));
        assert(result.route === 'text-brain', 'route should be text-brain, saw ' + result.route);
        assert(result.manifest.modelBudgetChars === 200000, 'mode 2 should use the 200k text-brain budget');
        assert(result.manifest.messageChars <= 200000, 'snapshot exceeds the text-brain budget');
        assert(result.manifest.autoDegradedFrom === 'full', 'big pack should ladder down from full');
        assert(result.manifest.transportTruncated === false, 'laddered handoff must not byte-clip');
        assert(wsFrames.length === 0, 'live WebSocket must receive NOTHING in mode 2, saw ' + wsFrames.length + ' frames');
        const slot = mode2.getEveContextStatus();
        assert(slot.chars === result.manifest.messageChars, 'text brain slot should hold the snapshot');

        const relayed = await mode2.relayUserUtterance('what cards do I have?');
        assert(relayed === true, 'mode 2 turn should relay through the brain');
        assert(brainRequests.length === 1, 'exactly one text_brain_request expected');
        const req = brainRequests[0];
        assert(req.text === 'what cards do I have?', 'user text should reach the brain');
        assert(String(req.context || '').includes('[EVEOS CONTEXT SNAPSHOT'), 'relayed snapshot marker missing from brain request');
        assert(String(req.context || '').length >= slot.chars, 'brain request should carry the full snapshot');
        assert(spoken[0] === 'what cards do I have?', 'user query should be handed to the live model to answer');
        assert(wsFrames.length === 1, 'exactly one system context frame should be sent');
        assert(wsFrames[0].is_system_context === true, 'frame should be system context');
        assert(wsFrames[0].realtime_input.media_chunks[0].data.includes('Brain reply about your cards.'), 'system context should contain extracted facts');
        assert(wsFrames[0].realtime_input.media_chunks[0].data.includes('authoritative facts for the current user turn'), 'live handoff must mark extracted facts authoritative');
        assert(wsFrames[0].realtime_input.media_chunks[0].data.includes('Do NOT claim the EveOS context is missing'), 'live handoff must prohibit false no-context replies');
        if (process.env.EVE_SMOKE_VERBOSE === '1') {
            console.log(`mode 2 routing OK: ${result.mode} snapshot (${result.manifest.messageChars} chars) -> brain slot -> next turn carried ${String(req.context).length} chars; live WS untouched`);
        }

        // Data Stream deltas also route to the brain in Mode 2 (the live session never sees them)
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.datastream.trace.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.datastream.js');
        wsFrames.length = 0; // Clear frames sent by context injection turn
        const streamResult = api.sendDataStreamToGemini(
            { source: 'state-mutated', kind: 'data', mutationSeq: 3, at: Date.now(), meta: { dataDelta: { complete: true, workspaceIds: ['main'], categoryNames: ['Test'], addedLinkIds: ['k1'] } } },
            { scope: { scope: 'workspace', workspaceId: 'main', workspaceIds: ['main'], categoryName: '', label: 'Main' } }
        );
        assert(streamResult.ok && streamResult.sent && streamResult.route === 'text-brain', 'mode 2 delta should route to the brain');
        assert(wsFrames.length === 0, 'mode 2 delta must not touch the live WebSocket');
        assert(mode2.getEveContextStatus().updateCount === 1, 'delta should land in the brain update log');
        mode2.resetBrainGate();   // clear the free-tier throttle between test turns
        await mode2.relayUserUtterance('and now?');
        const req2 = brainRequests[1];
        assert(wsFrames.length === 1, 'identical extracted facts must be handed off again for the one-shot next turn');
        assert(String(req2.context || '').includes('[EVEOS DATA STREAM UPDATES'), 'delta log missing from next brain turn');
        assert(String(req2.context || '').includes('eveos.gemini-data-stream.v2'), 'delta payload missing from next brain turn');

        const oversizedUpdate = '[OVERSIZED SELECTIVE UPDATE]\n' + 'x'.repeat(90000);
        const oversizedResult = mode2.appendEveUpdate(oversizedUpdate);
        assert(oversizedResult.count === 1, 'one oversized update must remain queued after bounded trimming');
        mode2.resetBrainGate();
        await mode2.relayUserUtterance('check the latest selective update');
        const req3 = brainRequests[2];
        assert(String(req3.context || '').includes('[OVERSIZED SELECTIVE UPDATE]'), 'oversized selective update vanished from the next brain turn');
        assert(String(req3.context || '').includes('[trimmed]'), 'oversized selective update should be visibly bounded');
        mode2.setEveContext('fresh snapshot', null);
        assert(mode2.getEveContextStatus().updateCount === 0, 'a fresh snapshot should clear the delta log');
        if (process.env.EVE_SMOKE_VERBOSE === '1') {
            console.log('mode 2 data stream OK: delta -> brain update log -> carried on next turn; cleared by fresh snapshot');
        }
    }

    // --- 5. Mode 1 regression: context still goes over the live WebSocket ---
    {
        const { context, wsFrames } = makeRelayVm({ textBrainMode: false });
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.shared.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.scope.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.bookmarks.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.nexus.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.local.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.sync.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.scope.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.transport.js');
        runScript(context, 'js/modules/features/modular-state-sync/modular-state-sync.api.context.js');
        const api = context.window.EveDataStore._modularSync;
        const result = await api.sendContextToGemini('summary', 30);
        assert(result.ok && result.sent && result.route === 'websocket', 'mode 1 should route over the websocket');
        assert(wsFrames.length > 0, 'mode 1 should emit websocket frames');
        assert(result.manifest.modelBudgetChars === 128000, 'mode 1 keeps the live-session budget');
        if (process.env.EVE_SMOKE_VERBOSE === '1') console.log('mode 1 regression OK: websocket route intact');
    }

    console.log('GEMINI_MODE2_CONTEXT_ROUTING_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
