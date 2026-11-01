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
    const audioSource = fs.readFileSync(AUDIO, 'utf8');
    const directRoute = audioSource.indexOf('await routeBrowserStream');
    const captureFallback = audioSource.indexOf('await musicCapture?.start');
    assert(directRoute >= 0 && captureFallback > directRoute, 'direct browser sink is attempted before main-thread PCM capture');
    assert(audioSource.includes('if (resumeMusicCapture) await musicCapture?.start?.(player, currentItem.id)'),
        'resuming a paused native-routed music track must restore its existing capture lane');
    // Queue completion has one owner (audioflix.queue.completion.js); ui.js only routes Ended to it.
    const uiSource = fs.readFileSync(UI, 'utf8');
    const completionSource = fs.readFileSync(COMPLETION, 'utf8');
    assert(uiSource.includes('EveAudioflixQueueCompletion'), 'UI routes Ended through the canonical queue completion owner');
    assert(completionSource.includes('Promise.resolve(detail.settle)'), 'queue advancement waits for the native tail handoff');
    vm.runInContext(completionSource, context, { filename: COMPLETION });
    const queue = { entries: [{ id: 'beta' }, { id: 'gamma' }, { id: 'delta' }],
        currentIndex: 0, playbackRunId: 1, isPlaying: true };
    let advances = 0;
    let advancing = Promise.resolve();
    const complete = window.EveAudioflixQueueCompletion.create({
        snapshot: () => queue,
        advance: () => {
            advances += 1;
            queue.currentIndex += 1;
            queue.playbackRunId += 1;
            advancing = controller.start(player, queue.entries[queue.currentIndex].id);
            return advancing;
        },
        restart: () => { throw new Error('Native queue handoff must advance, not repeat'); }
    });
    const settle = controller.stop({ drain: true });
    const ended = { status: 'Ended', item: { id: 'beta' }, settle };
    assert(complete(ended) === true, 'natural Ended claims the current native queue run');
    assert(complete(ended) === false && complete({ ...ended }) === false,
        'duplicate Ended objects cannot claim the same queue run');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert(advances === 0 && queue.currentIndex === 0, 'native drain holds advancement until the tail settles');
    assert(frameTap === null && !controller.isActive(), 'ending native capture releases its frame tap');
    await settle;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(await advancing, 'next native capture starts after drain');
    assert(advances === 1 && queue.currentIndex === 1, 'duplicate Ended advances exactly one slot, without skipping');
    assert(complete(ended) === false, 'late Ended cannot advance the successor');
    const gammaStream = controller.getStats().streamId;
    assert(gammaStream.startsWith('music:gamma:') && gammaStream !== betaStream,
        'queue successor owns a fresh native stream');
    assert(stopped.length === 1, 'natural drain does not clear the native tail');
    await controller.stop();
    assert(stopped.length === 2 && stopped[1].itemId === gammaStream,
        'successor cleanup targets only its exact native stream');
    assert(frameTap === null && !controller.isActive(), 'final native capture and tap are released');

    console.log('AUDIOFLIX_NATIVE_HANDOFF_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
