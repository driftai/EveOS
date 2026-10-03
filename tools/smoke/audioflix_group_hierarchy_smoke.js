const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const run = (ctx, name) => vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'modules', 'features', 'audioflix', name), 'utf8'),
    ctx,
    { filename: name }
);

const stored = {
    music: [
        { id: 'root-song', title: 'Root Song', url: 'https://example.test/root.mp3' },
        { id: 'child-song', title: 'Child Song', url: 'https://example.test/child.mp3' },
        { id: 'deep-song', title: 'Deep Song', url: 'https://example.test/deep.mp3' }
    ],
    soundboard: [{ id: 'deep-sound', title: 'Deep Sound', url: 'https://example.test/deep.wav' }],
    musicGroups: ['Main', 'Sub', 'Deep'],
    soundboardGroups: ['FX', 'Weather', 'Rain'],
    musicGroupParents: { Sub: 'Main', Deep: 'Sub', Main: 'Deep', Orphan: 'Missing' },
    soundGroupParents: { Weather: 'FX', Rain: 'Weather' },
    musicGroupMap: { 'root-song': ['Main'], 'child-song': ['Sub'], 'deep-song': ['Deep'] },
    soundGroupMap: { 'deep-sound': ['Rain'] }
};
const slots = { eveAudioflixFallbackState: JSON.stringify(stored) };
const ctx = {
    console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise, RegExp,
    queueMicrotask, setTimeout, clearTimeout,
    localStorage: { getItem: (key) => slots[key] || null, setItem: (key, value) => { slots[key] = String(value); } },
    config: {},
    document: { getElementById() { return null; }, createElement() { return { id: '', textContent: '' }; }, head: { appendChild() {} }, addEventListener() {} },
    window: { dispatchEvent() {}, addEventListener() {}, EveAudioflixNative: {} },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; }
};
Object.assign(ctx.window, { window: ctx.window, document: ctx.document, localStorage: ctx.localStorage, CustomEvent: ctx.CustomEvent, setTimeout, clearTimeout });

['audioflix.paths.js', 'audioflix.groups.tree.js', 'audioflix.state.schema.js', 'audioflix.state.recovery.js',
    'audioflix.state.groups.js', 'audioflix.state.js', 'audioflix.localize.audit.js',
    'audioflix.localize.port.js', 'audioflix.localize.js', 'audioflix.ui.group-tree.js']
    .forEach((name) => run(ctx, name));

const state = ctx.window.EveAudioflixState;
const tree = ctx.window.EveAudioflixGroupTree;
const snapshot = state.ensure();

assert.equal(JSON.stringify(snapshot.musicGroupParents), JSON.stringify({ Sub: 'Main', Deep: 'Sub' }), 'normalization drops cycles and orphan parent links');
assert.deepEqual(Array.from(tree.path(snapshot, 'music', 'Deep')), ['Main', 'Sub', 'Deep']);
assert.deepEqual(Array.from(tree.descendants(snapshot, 'music', 'Main')), ['Sub', 'Deep']);
assert.deepEqual(Array.from(tree.membershipNames(snapshot, 'music', 'Main')), ['Main', 'Sub', 'Deep']);
assert.deepEqual(Array.from(tree.deepest(snapshot, 'music', ['Main', 'Deep'])), ['Deep']);

const mainMembers = tree.itemsForGroup(snapshot, 'music', 'Main', snapshot.music);
assert.deepEqual(Array.from(mainMembers, (item) => item.id), ['root-song', 'child-song', 'deep-song'], 'parent scope includes descendant memberships');
assert.equal(ctx.window.EveAudioflixLocalize.collectScope('group', 'Main').length, 3, 'parent localization includes descendant tracks');

assert.equal(state.setGroupParent('music', 'Main', 'Deep').ok, false, 'cyclic reparent is rejected');
assert.equal(state.setGroupParent('music', 'Deep', '').ok, true, 'group can move back to root');
state.renameGroup('music', 'Sub', 'Middle');
assert.equal(state.ensure().musicGroupParents.Middle, 'Main', 'renamed child keeps its parent');
state.setGroupParent('music', 'Deep', 'Middle');
state.removeMusicGroup('Middle');
assert.equal(state.ensure().musicGroupParents.Deep, 'Main', 'deleting a parent promotes children to its parent');

const ui = ctx.window.EveAudioflixGroupTreeUi;
const entries = tree.entries(state.ensure(), 'music', state.ensure().music);
const html = ui.renderSelector({ type: 'music', entries, active: 'Deep', esc: String, bucket: 'musicGroups', filters: { pillClass: () => '', pillTitle: () => '' } });
assert.match(html, /data-af-action="toggle-group-branch"/);
assert.match(html, /aria-expanded=/);
assert.match(html, /Main.*Deep/s);
const tag = ui.renderTags({ type: 'music', groups: ['Deep'], state: state.ensure(), esc: String });
assert.match(tag, /Main[^<]*.*Middle|Main.*Deep/s, 'nested card marker exposes an ancestor path');

console.log('AUDIOFLIX_GROUP_HIERARCHY_SMOKE_OK');
