'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const LAYERS = path.join(ROOT, 'js', 'modules', 'features', 'audioflix',
    'audioflix.audio.layers.js');
const ACTIONS = path.join(ROOT, 'js', 'modules', 'features', 'audioflix',
    'audioflix.ui.actions.js');
const NATIVE = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.native.js');
const WAVEFORM = path.join(ROOT, 'js', 'modules', 'features', 'audioflix',
    'audioflix.audio.waveform.js');

function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function main() {
    const players = [];
    const clearedVoices = [];
    const playedVoiceIds = [];
    let playVoiceResult = Promise.resolve(true);

    class FakeAudio {
        constructor() {
            this.currentTime = 0;
            this.paused = false;
            this.listeners = {};
            players.push(this);
        }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        play() { return Promise.resolve(); }
        pause() { this.paused = true; }
    }

    const window = {
        EveAudioflixAudioLayers: {},
        EveAudioflixAudioSource: { needsResolution: () => false },
        EveAudioflixState: { normalizeVolume: (value, fallback) => Number(value ?? fallback) },
        EveAudioflixAudio: { getWaveformController: () => null },
        EveAudioflixNative: {
            shouldSuppressBrowserPlayback: () => true,
            playVoice: (_audio, options) => {
                playedVoiceIds.push(options?.voiceId || '');
                return playVoiceResult;
            },
            clearVoices: async (id) => { clearedVoices.push(id); }
        }
    };
    const sandbox = { window, Audio: FakeAudio, Map, Promise, console };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(LAYERS, 'utf8'), sandbox, { filename: LAYERS });

    const decoded = deferred();
    const controller = window.EveAudioflixAudioLayers.createController({
        state: () => ({}),
        shouldPreferUrl: () => false,
        tryNativePlayback: async () => false,
        getDecodedBuffer: () => decoded.promise,
        encodeBufferToBase64: () => 'pcm'
    });
    const pendingDecode = controller.layerPlay({ id: 'delayed-decode', url: 'file.mp3' });
    controller.stopItemLayers('delayed-decode');
    decoded.resolve({ sampleRate: 48000 });
    assert(await pendingDecode === false, 'Stop cancels a layer still waiting for decode');
    assert(clearedVoices.length === 0, 'cancelled decode never reaches native playback');

    const voice = deferred();
    playVoiceResult = voice.promise;
    const nativeController = window.EveAudioflixAudioLayers.createController({
        state: () => ({}),
        shouldPreferUrl: () => false,
        tryNativePlayback: async () => false,
        getDecodedBuffer: async () => ({ sampleRate: 48000 }),
        encodeBufferToBase64: () => 'pcm'
    });
    const pendingVoice = nativeController.layerPlay({ id: 'delayed-voice', url: 'voice.mp3' });
    await tick();
    nativeController.stopItemLayers('delayed-voice');
    voice.resolve(true);
    assert(await pendingVoice === false, 'Stop cancels a layer while native playback starts');
    assert(clearedVoices.some((id) => id.startsWith('delayed-voice::layer:')),
        'late native playback is explicitly cleared by its unique layer voice id');

    playVoiceResult = Promise.resolve(true);
    const layerEvents = [];
    const layeredNativeController = window.EveAudioflixAudioLayers.createController({
        state: () => ({}),
        shouldPreferUrl: () => false,
        tryNativePlayback: async () => false,
        getDecodedBuffer: async () => ({ sampleRate: 48000, duration: 12 }),
        encodeBufferToBase64: () => 'pcm',
        dispatch: (name, detail) => {
            if (name === 'eve:audioflix-layer-voices') layerEvents.push(detail);
        }
    });
    await layeredNativeController.layerPlay({ id: 'layer-stack', title: 'Stack', url: 'stack.mp3' });
    await layeredNativeController.layerPlay({ id: 'layer-stack', title: 'Stack', url: 'stack.mp3' });
    const activeStack = layeredNativeController.getSnapshot('layer-stack');
    assert(activeStack.length === 2, 'two Layer Play presses retain two independent active voices');
    assert(activeStack[0].id !== activeStack[1].id,
        'each layered native play receives a distinct voice identity');
    assert(activeStack[0].sequence !== activeStack[1].sequence,
        'each layer keeps a stable internal transport sequence');
    assert(activeStack.every((voice) => voice.duration === 12 && voice.remaining > 0),
        'each active voice reports duration and remaining time');
    assert(layerEvents.at(-1)?.voices?.length === 2,
        'the UI receives the complete layered voice stack');
    const stackVoiceIds = playedVoiceIds.filter((id) => id.startsWith('layer-stack::layer:'));
    await Promise.allSettled(layeredNativeController.stopItemLayers('layer-stack'));
    assert(stackVoiceIds.length === 2 && stackVoiceIds.every((id) => clearedVoices.includes(id)),
        'Stop clears every independently routed native layer');
    assert(layerEvents.at(-1)?.voices?.length === 0,
        'Stop immediately clears the visual layer stack');

    window.EveAudioflixNative.shouldSuppressBrowserPlayback = () => false;
    const browserController = window.EveAudioflixAudioLayers.createController({
        state: () => ({}),
        shouldPreferUrl: () => false,
        tryNativePlayback: async () => false
    });
    await browserController.layerPlay({ id: 'layer-a', url: 'a.mp3' });
    await browserController.layerPlay({ id: 'layer-b', url: 'b.mp3' });
    const playerA = players.find((player) => player.src === 'a.mp3');
    const playerB = players.find((player) => player.src === 'b.mp3');
    browserController.stopItemLayers('layer-a');
    assert(playerA?.paused && playerA.currentTime === 0, 'the requested browser layer stops and rewinds');
    assert(playerB && !playerB.paused, 'stopping one layer leaves unrelated layers playing');

    let nativeMediaStops = 0;
    const nativeMediaController = window.EveAudioflixAudioLayers.createController({
        state: () => ({}),
        shouldPreferUrl: () => false,
        tryNativePlayback: async () => true,
        stopNativeItem: async () => { nativeMediaStops += 1; }
    });
    assert(await nativeMediaController.layerPlay({ id: 'native-media', type: 'music', url: 'media.wav' }),
        'successful native media layer starts');
    await Promise.allSettled(nativeMediaController.stopItemLayers('native-media'));
    assert(nativeMediaStops === 1, 'Stop owns and terminates a successful native media layer');

    const delayedNativeStart = deferred();
    let delayedNativeStops = 0;
    const delayedNativeController = window.EveAudioflixAudioLayers.createController({
        state: () => ({}),
        shouldPreferUrl: () => false,
        tryNativePlayback: () => delayedNativeStart.promise,
        stopNativeItem: async () => { delayedNativeStops += 1; }
    });
    const pendingNativeMedia = delayedNativeController.layerPlay({
        id: 'delayed-native-media', type: 'sound', url: 'delayed.wav'
    });
    delayedNativeController.stopItemLayers('delayed-native-media');
    delayedNativeStart.resolve(true);
    assert(await pendingNativeMedia === false,
        'Stop invalidates a native media layer whose start request is still pending');
    assert(delayedNativeStops === 1,
        'a native media layer that starts after Stop is terminated immediately');

    const actionWindow = {
        EveAudioflixUiActions: {},
        EveAudioflixUiActionsLocalize: { create: () => async () => false },
        EveAudioflixUiActionsNexus: { create: () => async () => false },
        EveAudioflixSpotifyUi: { createActions: () => async () => false },
        EveAudioflixUiForms: { create: () => async () => false }
    };
    let actionLayerItem = null;
    let actionPlayItem = null;
    let actionPlayCount = 0;
    let actionLayerStopped = false;
    const hotkeyClear = deferred();
    const actionVoiceClears = [];
    actionWindow.EveAudioflixAudio = {
        layerPlay: async (item) => { actionLayerItem = item; return true; },
        playItem: async (item) => { actionPlayItem = item; actionPlayCount += 1; return true; },
        stopItemLayers: async () => { actionLayerStopped = true; return true; }
    };
    actionWindow.EveAudioflixNative = { clearVoices: (id) => { actionVoiceClears.push(id); return hotkeyClear.promise; } };
    const actionSandbox = { window: actionWindow, document: {}, Promise, console };
    vm.createContext(actionSandbox);
    vm.runInContext(fs.readFileSync(path.join(path.dirname(ACTIONS), 'audioflix.ui.actions.routing.js'), 'utf8'), actionSandbox);
    vm.runInContext(fs.readFileSync(ACTIONS, 'utf8'), actionSandbox, { filename: ACTIONS });
    const actionHandler = actionWindow.EveAudioflixUiActions.create({
        findItem: () => ({ id: 'file-sound', url: 'clip.wav' }),
        portedSounds: [],
        stopRepeater: () => {}
    }).handleAction;
    await actionHandler({ dataset: { afAction: 'layer-play', afId: 'file-sound', afType: 'sound' } });
    assert(actionLayerItem?.type === 'sound', 'Layer Play preserves the UI sound type on file://');
    const pendingActionStop = actionHandler({
        dataset: { afAction: 'stop-item', afId: 'file-sound', afType: 'sound' }
    });
    await tick();
    assert(actionLayerStopped, 'visible Stop is not blocked by the file:// hotkey bridge request');
    assert(actionVoiceClears.includes('file-sound'), 'Stop clears a direct layer voice after browser state is lost');
    assert(actionVoiceClears.includes('hk:file-sound'), 'Stop also clears the global-hotkey voice');
    hotkeyClear.resolve(true);
    await pendingActionStop;

    actionLayerStopped = false;
    actionVoiceClears.length = 0;
    await actionHandler({ dataset: { afAction: 'play', afId: 'file-sound', afType: 'sound' } });
    assert(actionLayerStopped, 'normal Play first clears an existing layer owner for the same sound');
    assert(actionVoiceClears.includes('file-sound') && actionVoiceClears.includes('hk:file-sound'),
        'normal Play clears direct and hotkey owners before starting');
    assert(actionPlayCount === 1, 'one normal Play click creates exactly one playback owner');
    assert(actionPlayItem?.type === 'sound', 'normal Play preserves the UI sound type on file://');

    const analysers = [];
    const gains = [];
    const bufferSources = [];
    const node = () => ({
        connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.disconnected = true; }
    });
    class FakeAudioContext {
        constructor() { this.destination = {}; this.state = 'running'; this.sampleRate = 48000; }
        createAnalyser() {
            const value = Object.assign(node(), {
                fftSize: 1024,
                frequencyBinCount: 512,
                getByteTimeDomainData() {}
            });
            analysers.push(value);
            return value;
        }
        createGain() {
            const value = Object.assign(node(), { gain: { value: 1 } });
            gains.push(value);
            return value;
        }
        createBufferSource() {
            const value = Object.assign(node(), {
                startArgs: null,
                stopCalls: 0,
                start(...args) { this.startArgs = args; },
                stop() { this.stopCalls += 1; }
            });
            bufferSources.push(value);
            return value;
        }
    }
    const waveformWindow = {
        EveAudioflixAudioWaveform: {},
        AudioContext: FakeAudioContext,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        devicePixelRatio: 1
    };
    const waveformSandbox = { window: waveformWindow, Uint8Array, WeakMap, WeakSet, console };
    vm.createContext(waveformSandbox);
    vm.runInContext(fs.readFileSync(WAVEFORM, 'utf8'), waveformSandbox, { filename: WAVEFORM });
    const waveform = waveformWindow.EveAudioflixAudioWaveform.createController(() => null);
    waveform.playBufferWaveform({ duration: 2 });
    assert(bufferSources.length === 1 && bufferSources[0].startArgs?.[1] === 0,
        'Soundboard visualization starts one analysis source at the requested offset');
    assert(analysers.length === 2 && bufferSources[0].connections[0] === analysers[1],
        'decoded Soundboard visualization uses a dedicated analyser');
    assert(gains.length === 2 && analysers[1].connections[0] === gains[1] && gains[1].gain.value === 0,
        'the visualizer analysis lane is silent instead of creating a second audible stream');
    assert(gains[0].gain.value === 1 && bufferSources[0].stopCalls === 0,
        'starting visualization does not disturb the shared Music Library output graph');
    waveform.stop();
    assert(bufferSources[0].stopCalls === 1,
        'Soundboard Stop terminates the visualizer buffer source instead of only hiding its drawing');

    const nativeSource = fs.readFileSync(NATIVE, 'utf8');
    assert(nativeSource.includes('allDevices = options.allDevices === true || (!!voiceId'),
        'specific voice cleanup requests all retained native output players');
    assert(nativeSource.includes('timeout: DEFAULT_TIMEOUT_MS, probe: true'),
        'user-initiated native Stop bypasses a stale bridge-offline cooldown');
    const backendProbe = spawnSync(process.env.PYTHON || 'python', ['-c', [
        'from server_modules import audioflix_bridge_playback as p',
        'class Fake:',
        '    def __init__(self): self.ids = []',
        '    def clear_voices(self, vid=None): self.ids.append(vid); return 1',
        'a, b = Fake(), Fake()',
        'p.sd = p.np = object()',
        'p._PLAYERS = {"sd:1:24000:1": a, "sd:2:48000:1": b}',
        'result = p.clear_voices({"deviceId": "sd:1", "voiceId": "clip", "allDevices": True})',
        'assert result["cleared"] == 2 and result["allDevices"] is True',
        'assert a.ids == ["clip"] and b.ids == ["clip"]',
        'import queue',
        'player = p._PcmPlayer.__new__(p._PcmPlayer)',
        'player.q, player.pending, player.flush_pending, player.stream_id = queue.Queue(), None, False, "owned-media"',
        'player.q.put(object())',
        'assert player.clear_stream("other-media") == 0 and player.q.qsize() == 1',
        'assert player.clear_stream("owned-media") == 1 and player.q.empty() and player.flush_pending',
        'assert player.stream_id is None'
    ].join('\n')], { cwd: ROOT, encoding: 'utf8' });
    assert(backendProbe.status === 0, `native all-device stop failed: ${backendProbe.stderr || backendProbe.stdout}`);

    const actions = fs.readFileSync(ACTIONS, 'utf8');
    const layerUi = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'features', 'audioflix',
        'audioflix.ui.layer-voices.js'), 'utf8');
    const layerCss = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'features', 'audioflix',
        'audioflix.layer-voices.css'), 'utf8');
    const renderSource = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'features', 'audioflix',
        'audioflix.ui.render.js'), 'utf8');
    assert(layerUi.includes('eve:audioflix-layer-voices') && layerUi.includes('voice.remaining')
        && layerUi.includes('const number = index + 1') && !layerUi.includes('Number(voice.sequence)'),
        'layer timeline UI does not retain per-play progress with compact per-sound numbering');
    assert(layerCss.includes('--af-layer-height') && renderSource.includes('data-af-layer-voices'),
        'sound cards do not host the compact shrinking layer timeline stack');

    const layerUiListeners = {};
    const layerHost = {
        dataset: { afLayerVoices: 'numbering-check' },
        style: { setProperty() {} },
        innerHTML: ''
    };
    const layerUiWindow = {
        EveAudioflixLayerVoices: {},
        addEventListener(name, listener) { layerUiListeners[name] = listener; }
    };
    const layerUiDocument = {
        querySelectorAll(selector) {
            return selector === '[data-af-layer-voices]' ? [layerHost] : [];
        }
    };
    const layerUiSandbox = { window: layerUiWindow, document: layerUiDocument, Map, console };
    vm.createContext(layerUiSandbox);
    vm.runInContext(layerUi, layerUiSandbox, { filename: 'audioflix.ui.layer-voices.js' });
    layerUiListeners['eve:audioflix-layer-voices']({ detail: {
        itemId: 'numbering-check',
        voices: [
            { sequence: 41, currentTime: 1, duration: 8, remaining: 7, progress: 0.125 },
            { sequence: 99, currentTime: 2, duration: 8, remaining: 6, progress: 0.25 }
        ]
    } });
    assert(layerHost.innerHTML.includes('Layer 1') && layerHost.innerHTML.includes('Layer 2')
        && !layerHost.innerHTML.includes('Layer 41') && !layerHost.innerHTML.includes('Layer 99'),
        'visible numbering starts at one for each sound instead of exposing global transport IDs');
    layerUiListeners['eve:audioflix-layer-voices']({ detail: {
        itemId: 'numbering-check',
        voices: [{ sequence: 99, currentTime: 3, duration: 8, remaining: 5, progress: 0.375 }]
    } });
    assert(layerHost.innerHTML.includes('Layer 1') && !layerHost.innerHTML.includes('Layer 2'),
        'remaining layered voices compact their visible numbering after an earlier voice finishes');
    const start = actions.indexOf("if (action === 'stop-item')");
    const end = actions.indexOf("if (action === 'toggle-repeater')", start);
    const stopBlock = actions.slice(start, end);
    const stopHelper = actions.slice(actions.indexOf('const stopItemPlayback'), actions.indexOf('async function handleAction'));
    assert(stopBlock.includes('stopItemPlayback') && stopHelper.includes('stopItemLayers'),
        'the visible Stop button reaches the layer controller');
    assert(!stopBlock.includes('EveAudioflixAudio?.pause'),
        'the layer Stop button cannot pause unrelated continuous playback');

    console.log('AUDIOFLIX_LAYER_STOP_SMOKE_OK');
}

main().catch((error) => { console.error(error); process.exit(1); });
