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
 * Provider-host playback also has a resilience layer now: if higher-level adapter identity drops a
 * live card-volume command, the active localhost provider iframe receives the same 0..100 YouTube
 * command directly. The same layer observes raw provider Ended state and advances only if the normal
 * queue handlers have not already moved the queue by the next task.
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

function functionBody(source, signature) {
    const start = source.indexOf(signature);
    assert(start >= 0, `missing function: ${signature}`);
    const next = source.indexOf('\n    function ', start + signature.length);
    return source.slice(start, next >= 0 ? next : source.length);
}

function main() {
    const url = read('audioflix.audio.url.js');
    const internal = read('audioflix.audio.internal.js');
    const audio = read('audioflix.audio.js');
    const overlay = read('audioflix.ui.overlay.js');
    const resilience = read('audioflix.transport.resilience.js');

    // ---- the panel's slider must persist, exactly as the card's does ----
    const setVolume = functionBody(url, 'function setVolume(');
    assert(setVolume.includes('setItemVolume'),
        'the internal panel persists its level through state, so it survives the next render');
    assert(setVolume.includes('view?.setVolume?.'),
        'the internal panel mirrors the level onto its own thumb');
    assert(/playback\.item\??\.type \|\| 'music'/.test(setVolume),
        'the item type is passed through rather than assumed, so state updates the right list');

    // ---- the card slider persists too (the leg that already worked must not regress) ----
    assert(overlay.includes('setItemVolume'), 'the card slider still persists through state');
    assert(overlay.includes('updateItemVolume'), 'the card slider still reaches the live player');
    assert(overlay.includes("String(activeId ?? '') === String(id ?? '') ? activeId : id"),
        'the card slider restores the active item ID type before updating playback');
    assert(overlay.includes("V.portedSounds.find(s => String(s.id ?? '') === String(id ?? ''))"),
        'ported/localized volume updates compare IDs by value instead of JS type');

    // ---- provider completion must have a foreground-independent queue handoff ----
    assert(overlay.includes('latestBridge.step?.(1)'),
        'the primary provider queue bridge advances through the existing queue controller');
    assert(overlay.includes('snapshot.repeatOne') && overlay.includes('latest.repeatOne'),
        'the provider fast path preserves repeat-one semantics');

    // ---- the card slider reaches the provider panel's audio by active transport identity ----
    const update = functionBody(audio, 'function updateItemVolume(');
    assert(update.includes('const activeUrlMatch = urlPlayback?.matches?.(itemId) === true'),
        'live provider identity is consulted before deciding whether the slider owns playback');
    assert(update.includes('urlPlayback.setVolume(safeVolume)'),
        'a card-slider change reaches the provider currently playing');

    // ---- and the panel exposes the mirror the url player calls ----
    assert(/setQueue, setRate, setVolume,/.test(internal),
        'the internal view exports setVolume, or the mirror call silently does nothing');
    const mirror = functionBody(internal, 'function setVolume(');
    assert(mirror.includes('.audioflix-provider-volume'),
        'the mirror targets the panel volume input');
    assert(mirror.includes('clamp('),
        'the mirrored value is clamped, so an out-of-range level cannot desync the thumb');

    // ---- localhost provider-host resilience covers the exact live route seen in server logs ----
    assert(resilience.includes(".audioflix-volume-slider, .audioflix-provider-volume"),
        'the resilience layer observes both Audioflix volume controls');
    assert(resilience.includes("action: 'volume'"),
        'the resilience layer can send a live provider-host volume command');
    assert(resilience.includes('Math.round(clamp(level) * 100)'),
        'provider-host live volume uses YouTube integer 0..100 units');
    assert(resilience.includes("detail.event !== 'state'") && resilience.includes("detail.state !== 'ended'"),
        'raw provider-host Ended state is observed even if an adapter drops the higher-level event');
    assert(resilience.includes('setTimeout(() => {') && resilience.includes('latestBridge.step?.(1)'),
        'the Ended fallback waits for normal handlers and advances only if the queue is still stuck');

    console.log('audioflix volume views OK — panel persists/mirrors and provider-host resilience is armed');
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
