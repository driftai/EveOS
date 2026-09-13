// structuredClone transfers really detach buffers; ordinary mocks missed the original bug.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../js/modules/gemini/agentic/' +
    'audio_proc/playback_proc/audio_injest_core/workletIngestHandler.js'), 'utf8');
const socketSource = fs.readFileSync(path.resolve(__dirname, '../../js/modules/gemini/client/' +
    'connection_management/socket_core/socketAudioLogic.js'), 'utf8');

function rig(mode = 'transfer') {
    const deliveries = [];
    let fallbacks = 0;
    const sandbox = { Float32Array, console: { log() {}, warn() {}, error() {} },
        setTimeout(fn) { fn(); },
        convertPCM16LEToFloat32: () => new Float32Array([0.25, -0.5, 1]),
        playAudioWithFallbackMethod() { fallbacks++; } };
    sandbox.window = { workletNode: { port: { postMessage(payload, transfer) {
        if (mode === 'fail' || (mode === 'copy' && transfer)) throw new Error('send failed');
        deliveries.push(structuredClone(payload, transfer ? { transfer } : undefined));
    } } } };
    vm.runInNewContext(source, sandbox);
    return { sandbox, deliveries, fallbackCount: () => fallbacks,
        send: () => sandbox.window.AudioIngestCore.WorkletIngestHandler.playViaWorklet(
            new ArrayBuffer(6), { usingFallback: true }) };
}

async function assertBrowserLiveGate() {
    const sent = [];
    const workletCommands = [];
    let hardStops = 0;
    let nativeStops = 0;
    let legacyMessages = 0;
    const socket = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); }, onmessage: null };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        JSON,
        Date,
        Promise,
        Set,
        WebSocket: { OPEN: 1 },
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        setTimeout,
        clearTimeout,
        stopAllAudioPlayback() { hardStops += 1; },
        updateConnectionStatus() {},
        document: { visibilityState: 'visible' }
    };
    sandbox.window = {
        webSocket: socket,
        handleSocketMessage: async () => { legacyMessages += 1; },
        AudioIngestCore: {},
        workletNode: { port: { postMessage(message) { workletCommands.push(message); } } },
        _workletCache: { 1: new Float32Array([1]) },
        audioQueue: [{ id: 1 }],
        generalAudioQueue: [{ id: 2 }],
        isPlayingFromQueue: true,
        EveAudioflixNative: { async stopStream() { nativeStops += 1; } },
        GeminiLiveToolBridge: { async execute(call) { return { ok: true, name: call.name }; } },
        dispatchEvent() {}
    };
    socket.onmessage = sandbox.window.handleSocketMessage;
    vm.runInNewContext(socketSource, sandbox, { filename: 'socketAudioLogic.js' });

    assert.equal(sandbox.window.handleSocketMessage.__eveLiveToolAware, true,
        'socket router is wrapped with Live tool/interruption handling');
    assert.equal(socket.onmessage, sandbox.window.handleSocketMessage,
        'an already-created socket is rebound to the wrapped router');

    await sandbox.window.handleSocketMessage({
        currentTarget: socket,
        data: JSON.stringify({ type: 'gemini_interrupted', reason: 'provider_barge_in' })
    });
    assert.equal(hardStops, 1, 'interruption hard-stops browser playback');
    assert.equal(nativeStops, 1, 'interruption flushes native Gemini stream lane');
    assert.equal(workletCommands.some(message => message.command === 'stop'), true,
        'interruption clears AudioWorklet buffered speech');
    assert.equal(sandbox.window.audioQueue.length, 0);
    assert.equal(sandbox.window.generalAudioQueue.length, 0);
    assert.equal(sandbox.window.isPlayingFromQueue, false);
    assert.equal(Object.keys(sandbox.window._workletCache).length, 0);
    assert.equal(sandbox.window.GeminiLiveAudioGate.epoch, 1,
        'interruption advances the audio epoch so stale async work cannot resume');

    await sandbox.window.handleSocketMessage({
        currentTarget: socket,
        data: JSON.stringify({
            type: 'gemini_tool_call',
            call: { requestId: 'call-1', name: 'eve_get_client_time', args: {} }
        })
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'gemini_tool_response');
    assert.equal(sent[0].requestId, 'call-1');
    assert.equal(sent[0].name, 'eve_get_client_time');
    assert.equal(sent[0].response.ok, true);

    // The same provider call cannot execute/send twice.
    await sandbox.window.handleSocketMessage({
        currentTarget: socket,
        data: JSON.stringify({
            type: 'gemini_tool_call',
            call: { requestId: 'call-1', name: 'eve_get_client_time', args: {} }
        })
    });
    assert.equal(sent.length, 1);

    await sandbox.window.handleSocketMessage({ currentTarget: socket, data: JSON.stringify({ text: 'legacy' }) });
    assert.equal(legacyMessages, 1, 'unrelated socket messages still reach the original router');
}

async function main() {
    const r = rig();
    await r.send();
    const w = r.sandbox.window;
    assert.deepEqual(Array.from(w._workletCache[1]), [0.25, -0.5, 1]);
    assert.equal(r.deliveries.length, 1, 'successful transfer must not also copy-send');
    w.workletNode.port.onmessage({ data: { type: 'requestMissing', seq: [1] } });
    assert.deepEqual(Array.from(r.deliveries[1].data), [0.25, -0.5, 1]);
    assert.deepEqual(Array.from(w._workletCache[1]), [0.25, -0.5, 1]);
    assert.equal(w._workletSeq, 1, 'resend does not consume a new sequence');
    for (let i = 0; i < 20; i++) await r.send();
    assert.equal(w._workletSeq, 21);
    assert.deepEqual(r.deliveries.slice(2).map(p => p.seq),
        Array.from({ length: 20 }, (_, i) => i + 2));
    assert.equal(Object.keys(w._workletCache).length, 16);
    assert.equal(w._workletCache[5], undefined);
    assert.ok(w._workletCache[6]);
    const fallback = rig('copy');
    await fallback.send();
    assert.equal(fallback.deliveries.length, 1);
    assert.deepEqual(Array.from(fallback.deliveries[0].data), [0.25, -0.5, 1]);
    const failed = rig('fail');
    await failed.send();
    assert.equal(failed.fallbackCount(), 1);
    assert.equal(failed.sandbox.window._workletSeq, undefined);
    assert.equal(failed.deliveries.length, 0);

    await assertBrowserLiveGate();
    console.log('PASS gemini-audio-resend: transfer/cache/resend/sequence/fallback/trim/interruption/tool-routing');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
