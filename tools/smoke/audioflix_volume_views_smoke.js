/**
 * audioflix_volume_views_smoke.js
 *
 * One track has two volume sliders and they must agree.
 *
 * The card slider (audioflix.transport.js) persisted through EveAudioflixState.setItemVolume and
 * pushed the level into the live player. The internal provider panel -- the compact player used for
 * Spotify/YouTube style tracks -- did neither: setVolume applied the level to the provider and
 * mutated the in-memory item, but never wrote to state. So a level set in the panel lasted only
 * until the next render, and the card kept showing the old number for the same track.
 *
 * The reverse leg was also broken: updateItemVolume already forwarded the card slider's value to
 * urlPlayback.setVolume, so the sound followed, but nothing moved the panel's thumb. The two views
 * showed different numbers for one track and the panel looked stuck.
 *
 * Pinned as source contracts. Exercising these for real needs a provider SDK, an iframe and a live
 * track, so the wiring would otherwise never be tested at all.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIOFLIX = path.join(ROOT, 'js', 'modules', 'features', 'audioflix');
const read = (name) => fs.readFileSync(path.join(AUDIOFLIX, name), 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error('ASSERT FAILED: ' + message);
}

function main() {
    const url = read('audioflix.audio.url.js');
    const internal = read('audioflix.audio.internal.js');
    const audio = read('audioflix.audio.js');
    const overlay = read('audioflix.ui.overlay.js');

    // ---- the panel's slider must persist, exactly as the card's does ----
    const setVolume = url.slice(url.indexOf('function setVolume('));
    const body = setVolume.slice(0, setVolume.indexOf('\n        }'));
    assert(body.includes('setItemVolume'),
        'the internal panel persists its level through state, so it survives the next render');
    assert(body.includes('view?.setVolume?.'),
        'the internal panel mirrors the level onto its own thumb');
    assert(/playback\.item\??\.type \|\| 'music'/.test(body),
        'the item type is passed through rather than assumed, so state updates the right list');

    // ---- the card slider persists too (the leg that already worked must not regress) ----
    assert(overlay.includes('setItemVolume'), 'the card slider still persists through state');
    assert(overlay.includes('updateItemVolume'), 'the card slider still reaches the live player');
    assert(overlay.includes("String(activeId ?? '') === String(id ?? '') ? activeId : id"),
        'the card slider restores the active item ID type before updating playback');
    assert(overlay.includes("V.portedSounds.find(s => String(s.id ?? '') === String(id ?? ''))"),
        'ported/localized volume updates compare IDs by value instead of JS type');

    // ---- provider completion must have a foreground-independent queue handoff ----
    assert(overlay.includes("detail.status !== 'Ended'") && overlay.includes("detail.provider !== 'spotify'"),
        'Spotify completion is not routed through the early provider queue bridge');
    assert(overlay.includes('latestBridge.step?.(1)'),
        'the provider queue bridge no longer advances through the existing queue controller');
    assert(overlay.includes('snapshot.repeatOne') && overlay.includes('latest.repeatOne'),
        'the provider fast path can override repeat-one semantics');

    // ---- the card slider reaches the provider panel's audio ----
    const update = audio.slice(audio.indexOf('function updateItemVolume('));
    assert(update.slice(0, 400).includes('urlPlayback.setVolume'),
        'a card-slider change reaches the provider currently playing');

    // ---- and the panel exposes the mirror the url player calls ----
    assert(/setQueue, setRate, setVolume,/.test(internal),
        'the internal view exports setVolume, or the mirror call silently does nothing');
    const mirror = internal.slice(internal.indexOf('function setVolume('));
    assert(mirror.slice(0, 300).includes('.audioflix-provider-volume'),
        'the mirror targets the panel volume input');
    assert(mirror.slice(0, 300).includes('clamp('),
        'the mirrored value is clamped, so an out-of-range level cannot desync the thumb');

    console.log('audioflix volume views OK — panel persists and mirrors, card preserves active identity');
    console.log('AUDIOFLIX_VOLUME_VIEWS_SMOKE_OK');

    const backgroundQueue = spawnSync(
        process.execPath,
        [path.join(__dirname, 'audioflix_background_queue_smoke.js')],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: 'inherit' }
    );
    if (backgroundQueue.status !== 0) {
        throw new Error(`background queue smoke failed with exit code ${backgroundQueue.status}`);
    }
}

main();