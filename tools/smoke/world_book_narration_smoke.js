'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const expect = (condition, message) => {
    if (!condition) throw new Error(message);
};

const bootstrap = read('tools', 'World-Book', 'app', 'assets', 'js', 'bootstrap.js');
const dialog = read('tools', 'World-Book', 'app', 'fragments', 'dialogs-narration.html');
const controller = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'controller.js');
const browser = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'browser.js');
const gemini = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'gemini.js');
const store = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'store.js');
const integrity = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'integrity.js');
const layout = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'layout.js');
const cacheUi = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'cache-ui.js');
const api = read('tools', 'World-Book', 'app', 'assets', 'js', 'api.js');
const ui = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'ui.js');
const bridge = read('js', 'modules', 'features', 'world-book', 'world-book.narration.bridge.js');
const companion = read('js', 'modules', 'features', 'world-book', 'world-book.narration.companion.js');
const localAudio = read('js', 'modules', 'features', 'world-book', 'world-book.narration.audio.js');
const localNative = read('js', 'modules', 'features', 'world-book', 'world-book.narration.native.js');
const localOutputs = read('js', 'modules', 'features', 'world-book', 'world-book.narration.outputs.js');
const localCache = read('js', 'modules', 'features', 'world-book', 'world-book.narration.cache.js');
const localGemini = read('js', 'modules', 'features', 'world-book', 'world-book.narration.gemini.js');
const localClips = read('js', 'modules', 'features', 'world-book', 'world-book.narration.clips.js');
const localRuntime = read('js', 'modules', 'features', 'world-book', 'world-book.narration.runtime.js');
const localAgentic = read('js', 'modules', 'features', 'world-book', 'world-book.narration.agentic.js');
const eveHtml = read('EveOS.html');
const overlaySource = read('js', 'modules', 'features', 'world-book', 'world-book.overlay.js');
const notesNarrationSource = read('js', 'modules', 'features', 'world-book', 'world-book.notes.narration.js');
const manager = read('js', 'modules', 'gemini', 'html_loaders', 'agentic', 'narration',
    'worldBookNarrationManagerUILoader.js');
const agenticConfig = read('js', 'modules', 'gemini', 'html_loaders', 'agentic', 'core',
    'agenticLoaderConfig.js');
const sessionLoop = read('server', 'gemini-backend', 'interactions', 'main_server_files',
    'websocket_server', 'session_handler', 'session_loop.py');
const responseHandler = read('server', 'gemini-backend', 'interactions', 'main_server_files',
    'response_processing', 'response_handler.py');
const sessionRegistry = read('server', 'gemini-backend', 'interactions', 'main_server_files',
    'session_management', 'core', 'session_registry.py');

expect(bootstrap.indexOf('narration/cache-ui.js') < bootstrap.indexOf('narration/ui.js'),
    'reader cache UI must load before narration UI');
expect(bootstrap.indexOf('narration/text.js') < bootstrap.indexOf('narration/integrity.js')
    && bootstrap.indexOf('narration/integrity.js') < bootstrap.indexOf('narration/store.js')
    && bootstrap.indexOf('narration/layout.js') < bootstrap.indexOf('narration/ui.js'),
    'reader support modules are not loaded in dependency order');
expect(dialog.includes('reader-file-input') && dialog.includes('reader-cache-list')
    && dialog.includes('reader-library-toggle') && dialog.includes('reader-progress-label')
    && dialog.includes('reader-detach-btn') && dialog.includes('max="1000"'),
    'reader library import/cache controls are missing');
expect(controller.includes('world-book-narration-v2') && controller.includes('world-book-narration-v1')
    && controller.includes('sourceTitle'),
    'narration cache identity is not source/policy aware');
expect(controller.includes('seekProgress') && controller.includes('overallRatio')
    && controller.includes('focusCachedPassage'),
    'continuous source seeking or cached-clip navigation is missing');
expect(controller.includes('cacheEpoch') && controller.includes('const source = { ...(this.source || {}) }'),
    'in-flight narration cache writes are not bound to their original source');
expect(controller.includes('this.gemini.cancelGeneration();') && controller.includes('this.gemini.stopPlayback();'),
    'stopping narration does not terminate generation and active playback together');
expect(store.includes('clearSource') && store.includes('inventory'),
    'source-aware cache management is missing');
expect(store.includes('sourceLocator') && store.includes('sourceHash') && store.includes('spokenText')
    && store.includes('durationSec') && store.includes('model'),
    'cache inventory does not retain narration provenance and integrity metadata');
expect(store.includes('isHostEvent') && store.includes('transaction.onabort'),
    'narration host/cache failure boundaries are incomplete');
expect(cacheUi.includes('Clear source') && cacheUi.includes('passagePreview')
    && cacheUi.includes('Go to') && cacheUi.includes('shortModel')
    && cacheUi.includes('compactLocator') && cacheUi.includes('inspectCachedRecord'),
    'cache inventory UI is incomplete');
expect(layout.includes('is-library-collapsed') && layout.includes('aria-expanded')
    && layout.includes('localStorage.setItem'),
    'reader private-document collapse state is not accessible or persistent');
expect(api.includes('/api/narration/document/download') && ui.includes('readerDocumentDownloadUrl'),
    'reader library cannot recover imported source files');
expect(gemini.includes('ws://127.0.0.1:9085') && gemini.includes('world_book_narration'),
    'World Book narration is not using the canonical isolated Gemini lane');
expect(localGemini.includes("ws://127.0.0.1:9085") && localGemini.includes("sessionRole: 'world_book_narration'"),
    'EveOS Notes narration does not share the canonical isolated Gemini lane');
expect(localAudio.includes('beginStream') && localAudio.includes('trimPcm')
    && /(?:ctx|context)\.state === 'running'/.test(localAudio)
    && localAudio.includes("context.state !== 'running'"),
    'EveOS narration audio lacks streaming, silence trimming, or running-context checks');
expect(localNative.includes("'/api/audioflix/play-voice'")
    && localNative.includes("deviceId: 'default'")
    && localNative.includes("'/api/audioflix/clear-voices'"),
    'EveOS narration lacks its audible Windows-default output contract');
expect(localOutputs.includes('nativeDefault') && localOutputs.includes('audioflix')
    && localOutputs.includes('SpeechSynthesisUtterance'),
    'EveOS narration output routes are not isolated behind the output adapter');
expect(localCache.includes("const DB_NAME = 'eve-world-book-narration'") && localCache.includes('cacheMb') && localCache.includes('cacheDays'),
    'EveOS narration cache does not preserve the World Book cache policy');
expect(localRuntime.includes('primeAudio') && localRuntime.includes("state.status = 'blocked'")
    && localRuntime.includes("Gemini unavailable - using browser speech."),
    'EveOS narration runtime lacks user-activation gating or browser fallback');
expect(localClips.includes('eveWorldBookNarrationClipRecipesV1') && localClips.includes('cleanHash')
    && localClips.includes('markRendered') && localRuntime.includes("'regenerate-clip'")
    && localRuntime.includes("'reload-source'"),
    'Notes narration lacks changed-clip tracking, per-clip recipes, or regeneration');
expect(localOutputs.includes('stopAll') && localRuntime.includes("stopAll?.('Switching narration output.')"),
    'Gemini fallback can overlap Browser TTS instead of switching outputs atomically');
expect(gemini.includes('outputTranscriptionEnabled: true') && gemini.includes('spokenText')
    && gemini.includes('startRatio') && gemini.includes('session_ready'),
    'Gemini narration lacks transcript capture, model provenance, or offset playback');
expect(!sessionLoop.includes('load_chat_history') && !sessionLoop.includes('chat_history ='),
    'Live session setup can preload disk chat history into the isolated narration lane');
expect(sessionLoop.includes('"type": "session_ready"') && sessionLoop.includes('output_transcription'),
    'narration sessions do not expose their resolved model or native transcript capability');
expect(responseHandler.includes('"type": "transcription"')
    && responseHandler.includes('self.session_role != "world_book_narration"'),
    'narration transcripts are not returned privately without polluting chat history');
expect(sessionRegistry.includes('session_role') && sessionRegistry.includes('== role'),
    'session eviction is not scoped by role');
expect(bridge.includes('EveAudioflixNative') && bridge.includes('playVoice'),
    'Audioflix narration routing bridge is missing');
expect(bridge.includes('pendingCommands') && bridge.includes('readyTargets'),
    'World Book commands are not queued behind the iframe readiness handshake');
expect(bridge.includes('activeReaderTarget') && bridge.includes('commandTargets()'),
    'Reader commands can reach multiple loaded World Book controllers');
expect(bridge.includes("activeMode === 'local'") && bridge.includes("eve:world-book-narration-local-state")
    && bridge.includes('options.local === true'),
    'Reader companion commands are not routed to EveOS Notes narration while World Book is stopped');
expect(companion.includes('documentPictureInPicture.requestWindow') && companion.includes('window.open(')
    && companion.includes('mountInline()'),
    'detached Reader controls lack Picture-in-Picture, popup, or in-page fallback coverage');
expect(companion.includes("command('seek-progress'") && companion.includes('open-reader-companion')
    && companion.includes('Audioflix native output'),
    'detached Reader controls are not linked to progress navigation and Audioflix routing');
expect(companion.includes('dataset.clipEngine') && companion.includes('dataset.clipVoice')
    && companion.includes('dataset.clipRegen') && companion.includes('Changed · regenerate')
    && companion.includes('reload-source'),
    'Reader companion lacks per-clip engine/voice, regenerate, or changed-text controls');
expect(eveHtml.indexOf('world-book.narration.companion.js')
    < eveHtml.indexOf('world-book.narration.bridge.js'),
    'the Reader companion does not load before its host bridge');
expect(eveHtml.indexOf('world-book.narration.native.js')
    < eveHtml.indexOf('world-book.narration.outputs.js')
    && eveHtml.indexOf('world-book.narration.outputs.js')
    < eveHtml.indexOf('world-book.narration.clips.js')
    && eveHtml.indexOf('world-book.narration.clips.js')
    < eveHtml.indexOf('world-book.narration.runtime.js')
    && eveHtml.indexOf('world-book.narration.bridge.js')
    < eveHtml.indexOf('world-book.narration.agentic.js'),
    'the Reader output/clip modules do not load before the narration runtime');
expect(overlaySource.includes('data-world-book-reader-controls')
    && overlaySource.includes('openCompanion'),
    'the EveOS World Book header cannot open the detached Reader companion directly');
expect(overlaySource.includes('notesNarration?.readAloud')
    && overlaySource.includes('notesNarration?.notifyChanged')
    && notesNarrationSource.includes('primeAudio')
    && notesNarrationSource.includes('setSourceProvider')
    && notesNarrationSource.includes('local: true')
    && !notesNarrationSource.includes('ns.client.start'),
    'Notes narration is not decoupled from the World Book server');
expect(companion.includes("document.querySelector('[data-world-book-reader-companion]')")
    && !overlaySource.includes('data-world-book-reader-companion'),
    'the in-page companion fallback collides with the World Book header control');
expect(manager.includes('same protected API key saved in Session Controls'),
    'Search Monitor does not explain the shared credential contract');
expect(!manager.includes('type="password"') && !manager.includes('geminiApiKey'),
    'Narration Manager introduced a second credential field');
expect(manager.includes('clearCacheArmedUntil') && manager.includes("button.textContent = 'Clear now'"),
    'Narration Manager cache deletion is not confirmation guarded');
expect(manager.includes('preferNativeOutput') && manager.includes('Prefer audible Windows output'),
    'Narration Manager does not expose the reliable Windows output preference');
expect(localAgentic.includes('Browser TTS voice (shared)')
    && localAgentic.includes("dataset.narrationField = FIELD")
    && bridge.includes('eveBrowserTtsVoice') && bridge.includes('eve:browser-tts-voice'),
    'Browser TTS voice is not shared between Agentic Narration Manager, Notes, and World Book');
expect(notesNarrationSource.includes('Reader playing') && notesNarrationSource.includes('Reader finished')
    && notesNarrationSource.includes('Windows default output'),
    'Notes narration does not report the truthful playback route and terminal state');
expect(manager.includes('cacheClearQueued') && !manager.includes('cacheStats = { count: 0, bytes: 0 }'),
    'Narration Manager fabricates cache-clear success before World Book confirms it');
expect(agenticConfig.includes('worldBookNarrationManagerUILoader'),
    'Narration Manager is not registered in the agentic loader');

const textSource = read('tools', 'World-Book', 'app', 'assets', 'js', 'narration', 'text.js');
const context = { window: { WorldBook: {} }, document: { getElementById() { return null; } } };
vm.runInNewContext(textSource, context, { filename: 'narration/text.js' });
const passages = context.window.WorldBook.NarrationText.split(
    'Dr. Vale arrived at 3.14 p.m. This is the next complete sentence.', 45
);
expect(passages.length >= 1 && passages.every(value => value.length <= 45),
    `narration splitter produced invalid passages: ${JSON.stringify(passages)}`);
expect(passages.join(' ').includes('Dr. Vale') && passages.join(' ').includes('3.14'),
    'narration splitter damaged abbreviations or decimals');

function editorSource(pathValue) {
    const fields = {
        'entry-name': { value: 'Shared title' },
        'entry-kind': { textContent: 'file' },
        'entry-path': { textContent: pathValue },
        breadcrumb: { textContent: `World / ${pathValue}` },
        'file-content-section': { hidden: true },
        'file-content': { value: '' },
        'entry-notes': { value: 'Same narration text' }
    };
    const sourceContext = {
        window: { WorldBook: {} },
        document: { getElementById(id) { return fields[id] || null; } }
    };
    vm.runInNewContext(textSource, sourceContext, { filename: 'narration/text.js' });
    return sourceContext.window.WorldBook.NarrationText.editorSource();
}

expect(editorSource('one/shared.md').id !== editorSource('two/shared.md').id,
    'same-title entries in different World Book paths share a narration cache identity');
expect(editorSource('one/shared.md').locator !== editorSource('two/shared.md').locator,
    'same-title entries in different World Book paths lack distinct reader locators');

const integrityContext = { window: { WorldBook: {} }, Uint16Array, Math };
vm.runInNewContext(integrity, integrityContext, { filename: 'narration/integrity.js' });
const integrityApi = integrityContext.window.WorldBook.NarrationIntegrity;
expect(integrityApi.compareTranscript('Leon protects Febe.', 'Leon protects Febe.').status === 'match',
    'matching narration transcripts are not verified');
expect(integrityApi.compareTranscript('Leon protects Febe.', 'Unrelated generated words here.').status === 'diverged',
    'divergent narration transcripts are not flagged');
expect(integrityApi.compareTranscript('Leon protects Febe.', '').status === 'unknown',
    'missing legacy transcripts are presented as verified');
expect(integrityApi.compactLocator('World / Main / Leon / Info').endsWith('Main > Leon > Info'),
    'duplicate-title source paths are not compacted into useful breadcrumbs');

let spokenUtterance = null;
class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
}
const browserContext = {
    SpeechSynthesisUtterance,
    window: {
        WorldBook: {},
        SpeechSynthesisUtterance,
        speechSynthesis: {
            cancel() {},
            getVoices() { return []; },
            speak(utterance) { spokenUtterance = utterance; }
        }
    }
};
vm.runInNewContext(browser, browserContext, { filename: 'narration/browser.js' });
let capturedBoundary = null;
void new browserContext.window.WorldBook.BrowserNarrator().speak('Quiet', {
    rate: 1,
    pitch: 0,
    volume: 0,
    browserVoice: ''
}, boundary => { capturedBoundary = boundary; });
expect(spokenUtterance?.pitch === 0 && spokenUtterance?.volume === 0,
    'browser narration replaces valid zero pitch/volume values with defaults');
spokenUtterance?.onboundary?.({ charIndex: 2, charLength: 3, elapsedTime: 125, name: 'word' });
expect(capturedBoundary?.charIndex === 2 && capturedBoundary?.charLength === 3
    && capturedBoundary?.name === 'word',
    'browser narration does not preserve word-boundary metadata for highlighting');

const hostMessages = [];
const hostListeners = {};
const worldBookTarget = { postMessage(message) { hostMessages.push(message); } };
const hostWindow = {
    EveWorldBookNarrationBridge: {},
    EveWorldBook: { getDetachedWindow() { return null; } },
    addEventListener(type, listener) { (hostListeners[type] ||= []).push(listener); },
    dispatchEvent() {}
};
const hostContext = {
    window: hostWindow,
    document: { querySelector() { return { contentWindow: worldBookTarget }; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    CustomEvent: class CustomEvent { constructor(type, value) { this.type = type; this.detail = value?.detail; } }
};
vm.runInNewContext(bridge, hostContext, { filename: 'world-book.narration.bridge.js' });
expect(hostWindow.EveWorldBookNarrationBridge.broadcastCommand('clear-cache') === 0,
    'an unready World Book target was treated as command-ready');
hostListeners.message.forEach(listener => listener({
    source: worldBookTarget,
    origin: 'http://127.0.0.1:8766',
    data: { type: 'eve-world-book-narration-ready' }
}));
expect(hostMessages.some(message => message.type === 'eve-world-book-narration-command'
    && message.action === 'clear-cache'), 'queued World Book command was not delivered after readiness');
hostWindow.EveWorldBookNarrationBridge.broadcastCommand('seek-progress', {
    data: { value: 425, autoplay: true }
});
expect(hostMessages.some(message => message.action === 'seek-progress'
    && message.data?.value === 425 && message.data?.autoplay === true),
    'detached Reader command payloads are lost by the host bridge');
hostListeners['eve:world-book-frame-loading'].forEach(listener => listener({ detail: { target: worldBookTarget } }));
expect(hostWindow.EveWorldBookNarrationBridge.broadcastCommand('open-reader') === 0,
    'a navigating World Book target retained a stale ready state');

expect(read('requirements.txt').includes('PyMuPDF=='),
    'PDF narration import dependency is missing from the install contract');

console.log('WORLD_BOOK_NARRATION_SMOKE_OK');
