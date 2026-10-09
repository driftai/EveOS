'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const lines = (file) => read(file).split(/\r?\n/).length;
const expectOrder = (source, before, after, label) => {
  const left = source.indexOf(before), right = source.indexOf(after);
  assert(left >= 0, `${label}: missing ${before}`);
  assert(right >= 0, `${label}: missing ${after}`);
  assert(left < right, `${label}: ${before} must load before ${after}`);
};

const bounded = [
  'server_modules/audioflix_spotify_fallback.py',
  'server_modules/audioflix_spotify_fallback_match.py',
  'server_modules/audioflix_spotify_scrape.js',
  'server_modules/audioflix_spotify_scrape_core.js',
  'js/modules/features/world-book/world-book.notes.workspace.js',
  'js/modules/gemini/search_monitor/searchMonitorAiHome.js',
  'js/modules/gemini/search_monitor/searchMonitorAiHome.markup.js',
  'tools/Nexus-Browser/dex/provider-control-routing.js',
  'tools/Nexus-Browser/dex/provider-control-done-watch.js'
];
for (const file of bounded) {
  assert(lines(file) <= 450, `${file} regressed above the 450-line first-party budget (${lines(file)})`);
}

const fallback = read('server_modules/audioflix_spotify_fallback.py');
assert(fallback.includes('audioflix_spotify_fallback_match import'), 'Spotify fallback wrapper is not wired to extracted matcher');
assert(fallback.includes('def localize_one('), 'Spotify fallback public localize_one entrypoint disappeared');

const scraper = read('server_modules/audioflix_spotify_scrape.js');
assert(scraper.includes("require('./audioflix_spotify_scrape_core')"), 'Spotify scraper is not wired to extracted core');
assert(scraper.includes('collectDomRows'), 'Spotify scraper DOM collection entrypoint disappeared');

const aiHome = read('js/modules/gemini/search_monitor/searchMonitorAiHome.js');
assert(aiHome.includes('EveOSSearchMonitorAiHomeMarkup?.markup'), 'Search Monitor controller is not using extracted markup');
const geminiManifest = read('js/config/manifest/scripts.parts/13-gemini.js');
expectOrder(geminiManifest, 'searchMonitorAiHome.markup.js', 'searchMonitorAiHome.js', 'Search Monitor manifest');

const routing = read('tools/Nexus-Browser/dex/provider-control-routing.js');
assert(routing.includes("require('./provider-control-done-watch')"), 'Provider routing is not wired to extracted DONE-watch helper');
assert(routing.includes('routeDoneWatch('), 'Provider routing no longer delegates DONE-watch actions');

const workspace = read('js/modules/features/world-book/world-book.notes.workspace.js');
const client = read('js/modules/features/world-book/world-book.notes.client.js');
assert(workspace.includes("direct('[data-eve-notes-save]', saveNote)"), 'Notes Save button lacks direct persistence binding');
assert(workspace.includes('ensureWorkspaceService({ userInitiated: true })'), 'File-backed Notes tabs no longer start Notes on explicit user activation');
assert(client.includes("write: (rootId, path, content, revision) => request('/api/notes/write', { rootId, path, content, revision }, 20000)"), 'Long Notes write timeout contract changed');

console.log(`STRUCTURAL_MODULE_SPLIT_SMOKE_OK (${bounded.length} bounded modules)`);
