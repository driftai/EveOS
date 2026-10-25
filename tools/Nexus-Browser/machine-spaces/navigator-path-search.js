'use strict';

// Read-only, bounded live discovery. The existing Machine Spaces grant and
// operation ledger remain the *only* authorization and request owners.
// No persistent index, shell, network listener, file mutation or daemon.
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'eveos.navigator.discovery.v1';
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.venv', '__pycache__',
  'dist', 'build', 'coverage', '.cache', '.next'
]);
const PRIVATE_SEGMENTS = new Set(['data/runtime', '.env', '.env.local', '.env.production']);

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function limit(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}
function slash(value) { return String(value || '').replace(/\\/g, '/'); }
function permittedRelative(relative) {
  const value = slash(relative).toLowerCase();
  const segments = value.split('/');
  return !segments.some(part => PRIVATE_SEGMENTS.has(part))
    && value !== 'data/runtime' && !value.startsWith('data/runtime/');
}
function scorePath(candidate, query) {
  const whole = slash(candidate).toLowerCase(), text = query.toLowerCase();
  const basename = whole.split('/').at(-1);
  if (basename === text) return 1000;
  if (basename.startsWith(text)) return 850 - Math.min(basename.length - text.length, 100);
  if (basename.includes(text)) return 700 - Math.min(basename.indexOf(text), 100);
  if (whole.includes(text)) return 550 - Math.min(whole.indexOf(text), 150);
  let index = 0, gaps = 0, previous = -1;
  for (let cursor = 0; cursor < whole.length && index < text.length; cursor += 1) {
    if (whole[cursor] !== text[index]) continue;
    if (previous >= 0) gaps += cursor - previous - 1;
    previous = cursor;
    index += 1;
  }
  return index === text.length ? Math.max(1, 300 - gaps) : 0;
}
function inside(root, candidate, api) {
  const relative = api.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + api.sep) && relative !== '..' && !api.isAbsolute(relative));
}
function canonical(fsImpl, absolute) {
  const native = fsImpl.realpathSync?.native;
  return native ? native(absolute) : fsImpl.realpathSync(absolute);
}
function status() {
  return {
    schema: SCHEMA,
    available: true,
    mode: 'bounded-live-scan',
    index: 'not-configured',
    mutationAuthority: 'machine-spaces',
    revalidateBeforeReadOrMutation: true,
    persistentIndex: false,
    sidecar: false
  };
}
function searchPaths({ repoRoot, query, options = {}, fsImpl = fs, resolveScopedPath } = {}) {
  if (typeof resolveScopedPath !== 'function')
    throw fault('NAVIGATOR_RESOLVER_REQUIRED', 'Navigator requires the existing Machine Spaces path resolver.');
  if (typeof query !== 'string' || !query.trim() || query.length > 128 || query.includes('\0'))
    throw fault('NAVIGATOR_BAD_QUERY', 'Navigator queries must be 1-128 nonempty characters.');
  const needle = query.trim();
  const maxEntries = limit(options.maxEntries, 2000, 5000);
  const maxResults = limit(options.maxResults, 30, 100);
  const maxDepth = limit(options.depth, 8, 16);
  const start = resolveScopedPath(repoRoot, options.path || '', { fsImpl, mustExist: true });
  if (!fsImpl.lstatSync(start.absolute).isDirectory())
    throw fault('NAVIGATOR_NOT_DIRECTORY', 'Navigator path must refer to a directory.');
  if (!permittedRelative(start.relative))
    throw fault('NAVIGATOR_PRIVATE_PATH', 'Private runtime paths are excluded from Navigator.');

  const api = start.api || path;
  const canonicalRoot = start.canonicalRoot || canonical(fsImpl, start.root);
  const queue = [{ absolute: start.absolute, relative: slash(start.relative), depth: 0 }];
  let examined = 0, truncated = false, denied = 0;
  const matches = [];
  while (queue.length && examined < maxEntries) {
    const item = queue.shift();
    let names;
    try { names = fsImpl.readdirSync(item.absolute).sort((a, b) => a.localeCompare(b)); }
    catch (error) {
      // An unreadable subtree is explicitly degraded, not silently presented
      // as a complete view of the authorized repository.
      if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOENT') {
        denied += 1; continue;
      }
      throw error;
    }
    for (const name of names) {
      if (examined >= maxEntries) { truncated = true; break; }
      const relative = slash(item.relative ? `${item.relative}/${name}` : name);
      if (!permittedRelative(relative) || SKIP_DIRS.has(name.toLowerCase())) continue;
      const absolute = api.join(item.absolute, name);
      let entry;
      try { entry = fsImpl.lstatSync(absolute); }
      catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOENT') {
          denied += 1; continue;
        }
        throw error;
      }
      examined += 1;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      // Do not trust a link-like/reparse-point directory merely because lstat
      // reports it as a directory. Revalidate each candidate's real identity.
      let verified;
      try { verified = canonical(fsImpl, absolute); }
      catch { denied += 1; continue; }
      if (!inside(canonicalRoot, verified, api)) { denied += 1; continue; }
      const ranking = scorePath(relative, needle);
      if (ranking > 0) matches.push({
        path: relative,
        name,
        type: entry.isDirectory() ? 'directory' : 'file',
        score: ranking
      });
      if (entry.isDirectory() && item.depth < maxDepth && !SKIP_DIRS.has(name.toLowerCase())) {
        queue.push({ absolute, relative, depth: item.depth + 1 });
      }
    }
  }
  truncated ||= queue.length > 0 || matches.length > maxResults;
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    ...status(),
    query: needle,
    scope: slash(start.relative || '.'),
    maxEntries, maxResults, examined,
    truncated, degraded: denied > 0, skippedUnavailable: denied,
    // Discoverable names are hints, not capabilities, filesystem truth,
    // or authorization to read/write anything under the returned path.
    results: matches.slice(0, maxResults)
  };
}
module.exports = { SCHEMA, SKIP_DIRS, scorePath, searchPaths, status };
