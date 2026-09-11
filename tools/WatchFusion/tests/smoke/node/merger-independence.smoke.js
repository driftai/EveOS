import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, VOXELVISION_ROOT } from '../../../src/server/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const TEXT_EXTENSIONS = new Set(['.bat', '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.txt']);
const SKIP_DIRS = new Set(['.git', '.runtime', 'node_modules', 'nuvio', 'original', 'test-results']);
const BASELINE_NAMES = ['Voxel' + 'Vision', 'watchparty-' + 'standalone', 'Nuvio-Onion-' + 'Wrapper'];

const REQUIRED_LIVE_FILES = [
  'server.js',
  'src/server/room-store.js',
  'src/server/realtime.js',
  'src/server/nuvio-config.js',
  'src/server/nuvio-proxy.js',
  'src/server/nuvio-routes.js',
  'public/client/nuvio-adapter.js',
  'scripts/GET-NUVIO.bat',
  'scripts/BUILD-NUVIO.bat',
  'nuvio/.gitkeep',
  'src/server/voxelvision-routes.js',
  'public/client/voxelvision-adapter.js',
  'voxelvision/package.json',
  'voxelvision/media-range.js',
  'voxelvision/youtube-import.js',
  'voxelvision/public/index.html',
  'voxelvision/public/media/voxelvision-demo.mp4',
  'voxelvision/scripts/verify.mjs'
];

function collectFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(absolute, output);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(absolute);
  }
  return output;
}

function findLegacyPathReferences() {
  const pathPatterns = BASELINE_NAMES.map(name => new RegExp(`original[\\\\/]${name}`, 'i'));
  return collectFiles(ROOT)
    .filter(file => file !== fileURLToPath(import.meta.url))
    .filter(file => pathPatterns.some(pattern => pattern.test(fs.readFileSync(file, 'utf8'))))
    .map(file => path.relative(ROOT, file).replace(/\\/g, '/'));
}

export async function runMergerIndependenceSmokes() {
  const results = [];
  try {
    const missing = REQUIRED_LIVE_FILES.filter(relative => !fs.existsSync(path.join(ROOT, relative)));
    assert.deepEqual(missing, [], `missing live merger files: ${missing.join(', ')}`);
    assert.equal(PROJECT_ROOT, ROOT);
    assert.equal(VOXELVISION_ROOT, path.join(ROOT, 'voxelvision'));

    const legacyReferences = findLegacyPathReferences();
    assert.deepEqual(legacyReferences, [], `live files still reference baseline paths: ${legacyReferences.join(', ')}`);
    results.push({ id: 'MERGE-01:original-independent-live-tree', status: 'PASS' });
  } catch (error) {
    results.push({ id: 'MERGE-01:original-independent-live-tree', status: 'FAIL', error: error.message });
  }
  return results;
}
