// structuredClone transfers really detach buffers; ordinary mocks missed the original bug.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../js/modules/gemini/agentic/' +
    'audio_proc/playback_proc/audio_injest_core/workletIngestHandler.js'), 'utf8');
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
    console.log('PASS gemini-audio-resend: transfer/cache/resend/sequence/fallback/trim');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
