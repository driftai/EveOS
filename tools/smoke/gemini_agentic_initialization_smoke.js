// Deterministic loader-race + Gemini Live browser-tool coverage: no network/model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const timers = [];
const storage = new Map();
const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Set,
    Date,
    Intl,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    localStorage: {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
    },
    document: {
        visibilityState: 'visible',
        createDocumentFragment() { return { appendChild() {} }; },
        createElement() { return {}; },
        head: { appendChild() {} }
    }
};
sandbox.window = { addEventListener() {} };
vm.createContext(sandbox);
const run = file => vm.runInContext(fs.readFileSync(path.join(root,
    'js/modules/gemini/agentic', file), 'utf8'), sandbox, { filename: file });

async function main() {
    run('Agentic_js_Functions.js');
    const stable = sandbox.window.AgenticFunctions;
    timers.splice(0).forEach(fn => fn());
    const names = ['TimePerception', 'ConversationMemory', 'AISelfTalk',
        'AudioProcessingControls', 'SessionControls', 'ScreenCaptureInterval'];
    for (const name of names) {
        const implementation = { execute: () => name };
        sandbox.window[name === 'AISelfTalk' ? 'AiSelfTalkAgentic' : name + 'Agentic'] = implementation;
        assert.equal(stable[name], implementation, name + ': late loader must resolve live namespace');
        assert.equal(stable[name].execute(), name);
    }

    run('conv_mem/conv_mem.js');
    const memory = sandbox.window.ConversationMemoryAgentic;
    const send = () => 'sent';
    memory.sendChatHistory = send;
    memory.historyMessages.add('existing');
    timers.splice(0).forEach(fn => fn());
    assert.equal(sandbox.window.ConversationMemoryAgentic, memory, 'preserve loaded namespace');
    assert.equal(memory.sendChatHistory, send, 'late initializer must not erase implementations');
    assert.ok(memory.historyMessages.has('existing'), 'preserve loaded history');
    assert.equal(stable.ConversationMemory, memory);
    assert.equal(sandbox.window.AgenticFunctions, stable);

    run('scr_cap/scr_cap.js');
    sandbox.initializeScreenCaptureModule();
    const screen = stable.ScreenCaptureInterval;
    screen.setScreenSharingState(true);
    assert.equal(sandbox.window.isScreenShared, true);
    assert.equal(screen.isScreenShared, true);
    screen.setCurrentFrame('fixture-frame');
    assert.equal(sandbox.window.currentFrameB64, 'fixture-frame');
    sandbox.window.currentFrameB64 = 'new-frame';
    assert.equal(screen.getCurrentFrame(), 'new-frame');
    assert.throws(() => screen.setScreenSharingState('true'), /boolean/);
    assert.throws(() => screen.setCurrentFrame({}), /string or null/);

    // The model-facing bridge is intentionally smaller than AgenticFunctions and never exposes
    // screen-frame contents or arbitrary property traversal.
    const bridge = sandbox.window.GeminiLiveToolBridge;
    assert.ok(bridge && typeof bridge.execute === 'function');
    assert.deepEqual(Array.from(bridge.names), [
        'eve_get_client_time',
        'eve_get_context_memory_state',
        'eve_set_context_memory_state',
        'eve_get_screen_share_state',
        'eve_get_audio_playback_diagnostics',
        'eve_get_session_state'
    ]);

    let memoryEnabled = true;
    memory.isContextMemoryEnabled = () => memoryEnabled;
    memory.setContextMemoryEnabled = enabled => { memoryEnabled = enabled; };
    assert.equal((await bridge.execute({ name: 'eve_get_context_memory_state', args: {} })).enabled, true);
    assert.equal((await bridge.execute({
        name: 'eve_set_context_memory_state', args: { enabled: false }
    })).enabled, false);
    await assert.rejects(
        bridge.execute({ name: 'eve_set_context_memory_state', args: { enabled: 'false' } }),
        /boolean/
    );

    const screenResult = await bridge.execute({ name: 'eve_get_screen_share_state', args: {} });
    assert.equal(screenResult.sharing, true);
    assert.equal(Object.prototype.hasOwnProperty.call(screenResult, 'currentFrameB64'), false);
    assert.equal(JSON.stringify(screenResult).includes('new-frame'), false);
    await assert.rejects(bridge.execute({ name: 'constructor', args: {} }), /not allowed/);

    console.log('PASS gemini-agentic-initialization: late namespaces, state, and explicit Live tool allowlist preserved');
}

main().catch(error => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
});
