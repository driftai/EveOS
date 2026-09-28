const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const featurePath = path.join(root, 'js/modules/features/audioflix/audioflix.library.next.js');
const uiPath = path.join(root, 'js/modules/features/audioflix/audioflix.library.next.ui.js');
const sharedPath = path.join(root, 'js/modules/features/audioflix/audioflix.ui.shared.js');

for (const file of [featurePath, uiPath, sharedPath]) {
    const source = fs.readFileSync(file, 'utf8');
    new vm.Script(source, { filename: file });
    assert.ok(source.length > 200, `${path.basename(file)} should not be empty`);
}

const sandbox = {
    window: {},
    document: { readyState: 'loading', addEventListener() {}, createElement() { return {}; }, head: { appendChild() {} } },
    localStorage: { getItem() { return '{}'; }, setItem() {} },
    indexedDB: undefined,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: class {}
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(featurePath, 'utf8'), sandbox, { filename: featurePath });
const api = sandbox.window.EveAudioflixLibraryNext;
const featureSource = fs.readFileSync(featurePath, 'utf8');
assert.equal(api.ready, true);
assert.match(featureSource, /Queue progression has one owner/);
assert.doesNotMatch(featureSource, /status !== 'Ended'[\s\S]{0,900}querySelector\('\[data-af-action="play"\]'\)\?\.click/);
assert.equal(api.earliest([
    { id: 'new', createdAt: 3000 },
    { id: 'old', createdAt: 1000 },
    { id: 'mid', createdAt: 2000 }
]).id, 'old');
assert.equal(api.numericRename('Song', new Set(['song', 'song (2)'])), 'Song (3)');

console.log('audioflix library next smoke: PASS');
