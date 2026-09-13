// Deterministic loader-race coverage: no network, browser, or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const timers = [];
const sandbox = { console: { log() {} }, Set,
    setTimeout(fn) { timers.push(fn); },
    localStorage: { getItem() { return null; } },
    document: { createDocumentFragment() { return { appendChild() {} }; },
        createElement() { return {}; }, head: { appendChild() {} } } };
sandbox.window = { addEventListener() {} };
vm.createContext(sandbox);
const run = file => vm.runInContext(fs.readFileSync(path.join(root,
    'js/modules/gemini/agentic', file), 'utf8'), sandbox);
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
console.log('PASS gemini-agentic-initialization: six late namespaces and memory state preserved');
