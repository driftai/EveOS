const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CAPTURE = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.capture.js');
const AUDIO = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.js');
const UI = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.js');
const COMPLETION = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.queue.completion.js');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

let frameTap = null;
const sent = [];
const stopped = [];
const waveform = {
    ensureGraph() {},
    setFrameTap(value) { frameTap = value; return Promise.resolve(value ? 1000 : 0); },
    setSpeakerMuted() {}
};
const window = {
    EveAudioflixAudioCapture: {},
    EveAudioflixAudioBridge: { encodePcm: () => 'pcm' },
    EveAudioflixNative: {
        isBridgeOffline: () => false,
        warm: async () => true,
        sendGeminiChunk: async (payload, detail) => { sent.push({ payload, ...detail }); return true; },
        stopStream: async (detail) => { stopped.push(detail); return true; }
    }
};
const context = vm.createContext({ window, console, Float32Array, Promise, Symbol, Date, Math, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(CAPTURE, 'utf8'), context, { filename: CAPTURE });

function frames(count = 450) {
    const data = new Float32Array(count).fill(0.1);
    frameTap?.({ numberOfChannels: 1, getChannelData: () => data }, 1000);
}

(async function main() {
    const player = { paused: false };
    const controller = window.EveAudioflixAudioCapture.createController({
        getWaveform: () => waveform,
        getPlayer: () => player,
        getVolume: () => 1
    });

    assert(await controller.start(player, 'alpha'), 'first native stream starts');
    frames();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const alphaStream = sent[0]?.streamId;
    assert(alphaStream?.startsWith('music:alpha:'), 'PCM chunks carry a unique track stream ID');
    await controller.stop();
    assert(stopped[0]?.itemId === alphaStream, 'manual stop targets the exact active stream');

    assert(await controller.start(player, 'beta'), 'second stream starts after the first handoff');
    frames();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const betaStream = sent.find((entry) => entry.streamId?.startsWith('music:beta:'))?.streamId;
    assert(betaStream && betaStream !== alphaStream, 'successive tracks cannot share a native stream queue');
    await controller.stop();

    const audioSource = fs.readFileSync(AUDIO, 'utf8');
    const directRoute = audioSource.indexOf('await routeBrowserStream');
    const captureFallback = audioSource.indexOf('await musicCapture?.start');
    assert(directRoute >= 0 && captureFallback > directRoute, 'direct browser sink is attempted before main-thread PCM capture');
    // Queue completion has one owner (audioflix.queue.completion.js); ui.js only routes Ended to it.
    const uiSource = fs.readFileSync(UI, 'utf8');
    const completionSource = fs.readFileSync(COMPLETION, 'utf8');
    assert(uiSource.includes('EveAudioflixQueueCompletion'), 'UI routes Ended through the canonical queue completion owner');
    assert(completionSource.includes('Promise.resolve(detail.settle)'), 'queue advancement waits for the native tail handoff');
    assert(/if \(consumed === key\) return false;/.test(completionSource), 'duplicate ended events are serialized');

    console.log('AUDIOFLIX_NATIVE_HANDOFF_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
