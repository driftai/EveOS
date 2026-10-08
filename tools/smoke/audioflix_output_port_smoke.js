// Shared Audioflix output-port contract: one persisted master gain must sit after per-item volume
// and every playback family must consume the resulting effective level.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIOFLIX = path.join(ROOT, 'js', 'modules', 'features', 'audioflix');
const read = (name) => fs.readFileSync(path.join(AUDIOFLIX, name), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

const updates = [];
const events = [];
const state = { outputVolume: 0.4 };
const context = vm.createContext({
    console,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: {
        EveAudioflixState: {
            ensure: () => state,
            update: (patch, reason) => { Object.assign(state, patch); updates.push({ patch, reason }); }
        },
        dispatchEvent: (event) => events.push(event)
    }
});
context.window.window = context.window;
context.window.CustomEvent = context.CustomEvent;
vm.runInContext(read('audioflix.output.port.js'), context, { filename: 'audioflix.output.port.js' });

const port = context.window.EveAudioflixOutputPort;
assert(Math.abs(port.effective(0.5) - 0.2) < 1e-9, 'item gain is multiplied by output gain');
assert(port.effective(8) === 0.4, 'item gain is clamped before output multiplication');
assert(port.setVolume(0.3, { persist: false }) === 0.3, 'live output gain accepts drag updates');
assert(state.outputVolume === 0.4 && port.level() === 0.3, 'drag updates do not rerender through persisted state');
assert(port.setVolume(0.25) === 0.25, 'output gain setter returns the clamped level');
assert(state.outputVolume === 0.25, 'output gain is persisted in Audioflix state');
assert(updates.at(-1)?.reason === 'audioflix-output-volume', 'output gain uses a named persistence reason');
assert(events.at(-1)?.type === 'eve:audioflix-output-volume', 'live transports receive the output-gain event');
assert(port.render(state).includes('EveOS Song Output Port'), 'routing UI exposes the shared output port');

const stateSource = read('audioflix.state.js');
const audio = read('audioflix.audio.js');
const spotifyNative = read('audioflix.native.spotify.js');
const spotifyVolume = read('audioflix.spotify.volume.js');
const url = read('audioflix.audio.url.js');
const layers = read('audioflix.audio.layers.js');
const native = read('audioflix.audio.native.js');
const routing = read('audioflix.routing.js');
const overlay = read('audioflix.ui.overlay.js');

assert(stateSource.includes('outputVolume: normalizeVolume(source.outputVolume, 1)'),
    'saved output gain is normalized with a backward-compatible 100% default');
assert(audio.includes('EveAudioflixOutputPort?.effective?.(safeItem.volume)'),
    'the shared media element starts at effective output volume');
assert(audio.includes("'eve:audioflix-output-volume'") && audio.includes('updateItemVolume(currentItem.id'),
    'changing master gain refreshes the active item immediately');
assert(url.includes('const audible = outputVolume(safe)')
    && url.includes('Math.round(audible * 100)')
    && url.includes("active.player.setVolume?.(audible)"),
    'provider APIs receive the effective output gain');
assert(url.includes('setItemVolume?.(playback.item.type') && url.includes('view?.setVolume?.(safe)'),
    'provider controls still persist and display per-item gain, not multiplied master gain');
assert(layers.includes("'eve:audioflix-output-volume'") && layers.includes('outputVolume(layer.volume)'),
    'active layered sounds are refreshed when master gain changes');
assert(native.includes('EveAudioflixOutputPort?.effective?.(item.volume)'),
    'native buffered streams start at effective output gain');
assert(routing.includes('EveAudioflixOutputPort?.render?.(snapshot)'),
    'the output port is mounted in the routing panel');
assert(overlay.includes('EveAudioflixOutputPort?.handleInput?.(t)'),
    'the routing slider is connected to live input handling');
assert(overlay.includes('EveAudioflixOutputPort?.handleChange?.(t)'),
    'the routing slider persists once on its change event');

// Normal Spotify playback must stay on Spotify. Alternate-source lookup may remain available for
// explicit compatibility tooling, but preparePlaybackSource itself must restore the canonical
// Spotify URL and keep generic direct-media/yt-dlp routing disabled.
const spotifyPrepare = spotifyNative.slice(
    spotifyNative.indexOf('async function preparePlaybackSource'),
    spotifyNative.indexOf('function installPlaybackSourceDecorator')
);
assert(spotifyNative.includes("PLAYBACK_POLICY_REVISION = 'official-embed-localhost-volume-v2'"),
    'Spotify normal playback policy is the official embed with localhost volume control');
assert(spotifyPrepare.includes("spotifyPlaybackMode: 'official-embed-localhost-volume'")
    && spotifyPrepare.includes('eveOwnedPlaybackSource: false')
    && spotifyPrepare.includes('preferEveDirectAudio: false'),
    'Spotify preparation keeps the official Spotify provider authoritative');
assert(!spotifyPrepare.includes('resolveSpotifyPlaybackSource')
    && !spotifyPrepare.includes("action: 'resolve-playback-source'"),
    'normal Spotify preparation never invokes alternate recording matching');
assert(spotifyVolume.includes('navigator.mediaDevices.getDisplayMedia')
    && spotifyVolume.includes('suppressLocalAudioPlayback')
    && spotifyVolume.includes('restrictOwnAudio: false')
    && spotifyVolume.includes('context.createGain()'),
    'localhost Spotify volume uses captured official Spotify tab audio through an EveOS GainNode');

console.log('AUDIOFLIX_OUTPUT_PORT_SMOKE_OK');