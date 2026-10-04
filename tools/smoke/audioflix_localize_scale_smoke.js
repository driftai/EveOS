const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const music = Array.from({ length: 125 }, (_, index) => ({
    id: `bulk-${index}`, title: `Bulk ${index}`, url: `https://y/${index}`
}));
const stored = {
    music,
    musicGroups: ['Bulk', 'Bulk Child'],
    musicGroupParents: { 'Bulk Child': 'Bulk' },
    musicGroupMap: Object.fromEntries(music.map((track) => [track.id, ['Bulk Child']]))
};
const slots = { eveAudioflixFallbackState: JSON.stringify(stored) };
const downloaded = [];
const localStorage = {
    getItem: (key) => slots[key] || null,
    setItem: (key, value) => { slots[key] = String(value); }
};
const document = {
    getElementById() { return null; },
    createElement() { return { id: '', textContent: '' }; },
    head: { appendChild() {} }
};
const ctx = {
    console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise, RegExp,
    queueMicrotask, setTimeout, clearTimeout, localStorage, document, config: {},
    window: { dispatchEvent() {}, addEventListener() {} },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; }
};
Object.assign(ctx.window, {
    window: ctx.window, localStorage, document, CustomEvent: ctx.CustomEvent, setTimeout, clearTimeout,
    EveAudioflixNative: {
        localizeTrack: async (track, dir) => {
            downloaded.push(track.id);
            return { ok: true, id: track.id, filePath: `${dir}/${track.title}.mp3`, ext: 'mp3', mp3: true };
        },
        scanLocalized: async (dir) => ({ ok: true, dir, files: [] })
    }
});
const run = (name) => vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'modules', 'features', 'audioflix', name), 'utf8'),
    ctx,
    { filename: name }
);
[
    'audioflix.paths.js', 'audioflix.groups.tree.js', 'audioflix.state.schema.js',
    'audioflix.state.groups.js', 'audioflix.state.recovery.js', 'audioflix.state.js',
    'audioflix.localize.audit.js', 'audioflix.localize.port.js', 'audioflix.localize.js'
].forEach(run);

(async () => {
    const result = await ctx.window.EveAudioflixLocalize.localizeScope('group', 'Bulk', 'D:/Bulk', () => {});
    assert.equal(result.total, 125);
    assert.equal(result.done, 125);
    assert.equal(downloaded.length, 125);
    console.log('AUDIOFLIX_LOCALIZE_SCALE_SMOKE_OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
