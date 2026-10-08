'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_PATH_CHARS = 2048;
const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_HASH_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_TREE_ENTRIES = 2000;
const MAX_SEARCH_FILES = 800;
const MAX_SEARCH_RESULTS = 100;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache']);

function fileError(code, message) { return Object.assign(new Error(message), { code }); }
function pathApiFor(value) { return /^[A-Za-z]:[\\/]/.test(String(value || '')) ? path.win32 : path; }
function cleanRoot(value) {
  const root = String(value || '').trim();
  if (!root || root.length > 1024 || root.includes('\0'))
    throw fileError('MACHINE_BAD_FILE_ROOT', 'A bounded repository root is required.');
  const api = pathApiFor(root);
  const resolved = api.resolve(root);
  return resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
}
function inside(root, candidate, api = pathApiFor(root)) {
  const relative = api.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}
function toSlash(value) { return String(value || '').replace(/\\/g, '/'); }
function cleanRelative(value, { allowRoot = true } = {}) {
  const raw = String(value ?? '').trim();
  if (raw.includes('\0') || raw.length > MAX_PATH_CHARS)
    throw fileError('MACHINE_BAD_FILE_PATH', 'Filesystem paths must be bounded text.');
  if (!raw || raw === '.') {
    if (!allowRoot) throw fileError('MACHINE_FILE_ROOT_MUTATION', 'The repository root cannot be mutated.');
    return '';
  }
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/') || raw.startsWith('\\'))
    throw fileError('MACHINE_FILE_ABSOLUTE_PATH', 'Filesystem operations accept repository-relative paths only.');
  const parts = raw.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (!parts.length) {
    if (!allowRoot) throw fileError('MACHINE_FILE_ROOT_MUTATION', 'The repository root cannot be mutated.');
    return '';
  }
  if (parts.some((part) => part === '..'))
    throw fileError('MACHINE_FILE_TRAVERSAL', 'Parent traversal is not permitted in Machine Spaces paths.');
  return parts.join('/');
}
function realpath(fsImpl, value) {
  const fn = fsImpl.realpathSync?.native || fsImpl.realpathSync;
  return fn.call(fsImpl.realpathSync, value);
}
function nearestExisting(fsImpl, api, candidate) {
  let current = candidate;
  while (!fsImpl.existsSync(current)) {
    const parent = api.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}
function resolveScopedPath(repoRoot, relativePath, {
  fsImpl = fs,
  mustExist = true,
  allowRoot = true,
  allowSymlinkLeaf = false
} = {}) {
  const root = cleanRoot(repoRoot);
  const api = pathApiFor(root);
  const relative = cleanRelative(relativePath, { allowRoot });
  const candidate = api.resolve(root, ...relative.split('/').filter(Boolean));
  if (!inside(root, candidate, api)) throw fileError('MACHINE_FILE_TRAVERSAL', 'Path escaped the repository root.');
  let canonicalRoot;
  try { canonicalRoot = realpath(fsImpl, root); }
  catch { throw fileError('MACHINE_FILE_ROOT_MISSING', 'Repository root is not available.'); }
  if (mustExist && !fsImpl.existsSync(candidate)) throw fileError('MACHINE_FILE_NOT_FOUND', `No file exists at ${relative || '.'}.`);
  const ancestor = nearestExisting(fsImpl, api, candidate);
  if (!ancestor) throw fileError('MACHINE_FILE_ROOT_MISSING', 'No canonical filesystem ancestor is available.');
  let canonicalAncestor;
  try { canonicalAncestor = realpath(fsImpl, ancestor); }
  catch { throw fileError('MACHINE_FILE_UNRESOLVED', 'Filesystem path could not be canonicalized.'); }
  if (!inside(canonicalRoot, canonicalAncestor, api))
    throw fileError('MACHINE_FILE_SYMLINK_ESCAPE', 'Filesystem path resolves outside the granted repository root.');
  if (fsImpl.existsSync(candidate)) {
    const stat = fsImpl.lstatSync(candidate);
    if (stat.isSymbolicLink() && !allowSymlinkLeaf)
      throw fileError('MACHINE_FILE_SYMLINK', 'Symlink leaves are not followed by Machine Spaces file capabilities.');
    if (!stat.isSymbolicLink()) {
      let canonical;
      try { canonical = realpath(fsImpl, candidate); }
      catch { throw fileError('MACHINE_FILE_UNRESOLVED', 'Filesystem path could not be canonicalized.'); }
      if (!inside(canonicalRoot, canonical, api))
        throw fileError('MACHINE_FILE_SYMLINK_ESCAPE', 'Filesystem path resolves outside the granted repository root.');
    }
  }
  return { root, canonicalRoot, relative, absolute: candidate, api };
}
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function hashFile(fsImpl, absolute, stat, { strict = false } = {}) {
  if (!stat.isFile()) return null;
  if (stat.size > MAX_HASH_BYTES) {
    if (strict) throw fileError('MACHINE_FILE_TOO_LARGE', `File exceeds the ${MAX_HASH_BYTES}-byte mutation hash limit.`);
    return null;
  }
  return sha256(fsImpl.readFileSync(absolute));
}
function typeOf(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}
function statProjection(fsImpl, resolved, { withHash = true } = {}) {
  const stat = fsImpl.lstatSync(resolved.absolute);
  return {
    path: toSlash(resolved.relative || '.'),
    type: typeOf(stat),
    size: stat.isFile() ? stat.size : null,
    mode: stat.mode & 0o777,
    modifiedAt: stat.mtime?.toISOString?.() || null,
    sha256: withHash ? hashFile(fsImpl, resolved.absolute, stat) : null
  };
}
function boundedInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
function operationDigest(operation) {
  return sha256(Buffer.from(JSON.stringify(operation)));
}
function assertExpectedHash(actual, expected) {
  const wanted = String(expected || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(wanted))
    throw fileError('MACHINE_FILE_HASH_REQUIRED', 'Mutations of existing files require the exact current SHA-256 hash.');
  if (actual !== wanted)
    throw fileError('MACHINE_FILE_CHANGED', 'The file changed after it was inspected; refresh its hash before mutating it.');
}
function contentBuffer(value) {
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length > MAX_WRITE_BYTES)
    throw fileError('MACHINE_FILE_WRITE_TOO_LARGE', `One file mutation is limited to ${MAX_WRITE_BYTES} UTF-8 bytes.`);
  return buffer;
}
function atomicWrite(fsImpl, api, absolute, buffer, mode = null) {
  const directory = api.dirname(absolute);
  if (!fsImpl.existsSync(directory) || !fsImpl.lstatSync(directory).isDirectory())
    throw fileError('MACHINE_FILE_PARENT_MISSING', 'Destination parent directory must already exist.');
  const temp = api.join(directory, `.eveos-machine-${process.pid}-${randomUUID()}.tmp`);
  try {
    fsImpl.writeFileSync(temp, buffer, { flag: 'wx', ...(Number.isInteger(mode) ? { mode } : {}) });
    fsImpl.renameSync(temp, absolute);
  } finally {
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch {}
  }
}
function previewPayload(kind, pathValue, before, after, extra = {}) {
  return {
    kind,
    path: toSlash(pathValue || '.'),
    before: before ? { sha256: before.sha256, bytes: before.bytes } : null,
    after: after ? { sha256: after.sha256, bytes: after.bytes } : null,
    ...extra
  };
}

function createFilesystemBroker({ fsImpl = fs } = {}) {
  function stat(repoRoot, relativePath) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true });
    return statProjection(fsImpl, resolved);
  }

  function list(repoRoot, relativePath = '', options = {}) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true });
    const container = fsImpl.lstatSync(resolved.absolute);
    if (!container.isDirectory()) throw fileError('MACHINE_FILE_NOT_DIRECTORY', 'files.list requires a directory.');
    const offset = boundedInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = boundedInt(options.limit, 1, MAX_LIST_ENTRIES, 100);
    const names = fsImpl.readdirSync(resolved.absolute).sort((a, b) => a.localeCompare(b));
    const entries = names.slice(offset, offset + limit).map((name) => {
      const absolute = resolved.api.join(resolved.absolute, name);
      const child = fsImpl.lstatSync(absolute);
      return { name, path: toSlash(resolved.relative ? `${resolved.relative}/${name}` : name), type: typeOf(child),
        size: child.isFile() ? child.size : null, modifiedAt: child.mtime?.toISOString?.() || null };
    });
    return { path: toSlash(resolved.relative || '.'), offset, limit, total: names.length,
      nextOffset: offset + entries.length < names.length ? offset + entries.length : null, entries };
  }

  function tree(repoRoot, relativePath = '', options = {}) {
    const start = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true });
    if (!fsImpl.lstatSync(start.absolute).isDirectory()) throw fileError('MACHINE_FILE_NOT_DIRECTORY', 'files.tree requires a directory.');
    const maxDepth = boundedInt(options.depth, 0, 6, 2);
    const limit = boundedInt(options.limit, 1, MAX_TREE_ENTRIES, 500);
    const entries = [];
    const queue = [{ absolute: start.absolute, relative: start.relative, depth: 0 }];
    while (queue.length && entries.length < limit) {
      const current = queue.shift();
      const names = fsImpl.readdirSync(current.absolute).sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (entries.length >= limit) break;
        const absolute = start.api.join(current.absolute, name);
        const child = fsImpl.lstatSync(absolute);
        const relative = current.relative ? `${current.relative}/${name}` : name;
        entries.push({ path: toSlash(relative), name, depth: current.depth, type: typeOf(child), size: child.isFile() ? child.size : null });
        if (child.isDirectory() && !child.isSymbolicLink() && current.depth < maxDepth && !SKIP_DIRS.has(name))
          queue.push({ absolute, relative, depth: current.depth + 1 });
      }
    }
    return { path: toSlash(start.relative || '.'), depth: maxDepth, limit, truncated: queue.length > 0 || entries.length >= limit, entries };
  }

  function read(repoRoot, relativePath, options = {}) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true, allowRoot: false });
    const fileStat = fsImpl.lstatSync(resolved.absolute);
    if (!fileStat.isFile()) throw fileError('MACHINE_FILE_NOT_FILE', 'files.read requires a regular file.');
    const offset = boundedInt(options.offset, 0, Math.max(0, fileStat.size), 0);
    const limit = boundedInt(options.limit, 1, MAX_READ_BYTES, Math.min(MAX_READ_BYTES, Math.max(1, fileStat.size - offset || MAX_READ_BYTES)));
    const count = Math.max(0, Math.min(limit, fileStat.size - offset));
    const buffer = Buffer.alloc(count);
    let bytesRead = 0;
    if (count) {
      const fd = fsImpl.openSync(resolved.absolute, 'r');
      try { bytesRead = fsImpl.readSync(fd, buffer, 0, count, offset); }
      finally { fsImpl.closeSync(fd); }
    }
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) throw fileError('MACHINE_FILE_BINARY', 'Binary files are not returned through the text file capability.');
    const fullHash = hashFile(fsImpl, resolved.absolute, fileStat);
    let lineCount = null;
    if (fileStat.size <= MAX_SCAN_BYTES) {
      const all = fsImpl.readFileSync(resolved.absolute, 'utf8');
      lineCount = all.length ? (all.match(/\n/g) || []).length + (all.endsWith('\n') ? 0 : 1) : 0;
    }
    return {
      path: toSlash(resolved.relative), offset, bytes: bytesRead, totalBytes: fileStat.size,
      nextOffset: offset + bytesRead < fileStat.size ? offset + bytesRead : null,
      text: chunk.toString('utf8'), sha256: fullHash, lineCount,
      hashTruncated: fullHash == null
    };
  }

  function search(repoRoot, query, options = {}) {
    const needle = String(query ?? '');
    if (!needle || needle.length > 512 || needle.includes('\0'))
      throw fileError('MACHINE_FILE_BAD_SEARCH', 'Search query must contain 1-512 text characters.');
    const start = resolveScopedPath(repoRoot, options.path || '', { fsImpl, mustExist: true });
    if (!fsImpl.lstatSync(start.absolute).isDirectory()) throw fileError('MACHINE_FILE_NOT_DIRECTORY', 'files.search path must be a directory.');
    const caseSensitive = options.caseSensitive === true;
    const wanted = caseSensitive ? needle : needle.toLowerCase();
    const maxFiles = boundedInt(options.maxFiles, 1, MAX_SEARCH_FILES, 250);
    const maxResults = boundedInt(options.maxResults, 1, MAX_SEARCH_RESULTS, 50);
    const results = [], queue = [start.absolute];
    let scannedFiles = 0, scannedBytes = 0;
    while (queue.length && scannedFiles < maxFiles && results.length < maxResults) {
      const current = queue.shift();
      const names = fsImpl.readdirSync(current).sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (results.length >= maxResults || scannedFiles >= maxFiles) break;
        const absolute = start.api.join(current, name);
        const item = fsImpl.lstatSync(absolute);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) {
          if (!SKIP_DIRS.has(name)) queue.push(absolute);
          continue;
        }
        if (!item.isFile() || item.size > MAX_SCAN_BYTES) continue;
        scannedFiles += 1; scannedBytes += item.size;
        const text = fsImpl.readFileSync(absolute, 'utf8');
        if (text.includes('\0')) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
          const column = haystack.indexOf(wanted);
          if (column < 0) continue;
          results.push({ path: toSlash(start.api.relative(start.root, absolute)), line: index + 1,
            column: column + 1, preview: lines[index].slice(Math.max(0, column - 120), column + needle.length + 240) });
        }
      }
    }
    return { query: needle, path: toSlash(start.relative || '.'), caseSensitive, scannedFiles, scannedBytes,
      truncated: queue.length > 0 || scannedFiles >= maxFiles || results.length >= maxResults, results };
  }

  function create(repoRoot, relativePath, content) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: false, allowRoot: false });
    if (fsImpl.existsSync(resolved.absolute)) throw fileError('MACHINE_FILE_EXISTS', 'Create requires an absent destination.');
    const buffer = contentBuffer(content);
    const after = { sha256: sha256(buffer), bytes: buffer.length };
    atomicWrite(fsImpl, resolved.api, resolved.absolute, buffer);
    return { path: toSlash(resolved.relative), sha256: after.sha256, bytes: after.bytes,
      preview: previewPayload('create', resolved.relative, null, after) };
  }

  function write(repoRoot, relativePath, content, expectedSha256) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true, allowRoot: false });
    const current = fsImpl.lstatSync(resolved.absolute);
    if (!current.isFile()) throw fileError('MACHINE_FILE_NOT_FILE', 'Write requires a regular file.');
    const currentHash = hashFile(fsImpl, resolved.absolute, current, { strict: true });
    assertExpectedHash(currentHash, expectedSha256);
    const buffer = contentBuffer(content), afterHash = sha256(buffer);
    const before = { sha256: currentHash, bytes: current.size }, after = { sha256: afterHash, bytes: buffer.length };
    atomicWrite(fsImpl, resolved.api, resolved.absolute, buffer, current.mode & 0o777);
    return { path: toSlash(resolved.relative), sha256: afterHash, bytes: buffer.length,
      preview: previewPayload('write', resolved.relative, before, after) };
  }

  function patch(repoRoot, relativePath, beforeText, afterText, expectedSha256) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true, allowRoot: false });
    const current = fsImpl.lstatSync(resolved.absolute);
    if (!current.isFile()) throw fileError('MACHINE_FILE_NOT_FILE', 'Patch requires a regular file.');
    const currentHash = hashFile(fsImpl, resolved.absolute, current, { strict: true });
    assertExpectedHash(currentHash, expectedSha256);
    const before = String(beforeText ?? ''), after = String(afterText ?? '');
    if (!before || before.length > MAX_WRITE_BYTES || after.length > MAX_WRITE_BYTES)
      throw fileError('MACHINE_FILE_BAD_PATCH', 'Patch before/after text must be nonempty and bounded.');
    const text = fsImpl.readFileSync(resolved.absolute, 'utf8');
    const first = text.indexOf(before);
    if (first < 0) throw fileError('MACHINE_FILE_PATCH_MISS', 'Exact patch source text was not found.');
    if (text.indexOf(before, first + before.length) >= 0)
      throw fileError('MACHINE_FILE_PATCH_AMBIGUOUS', 'Exact patch source text occurs more than once.');
    const next = `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
    const buffer = contentBuffer(next), afterHash = sha256(buffer);
    atomicWrite(fsImpl, resolved.api, resolved.absolute, buffer, current.mode & 0o777);
    return { path: toSlash(resolved.relative), sha256: afterHash, bytes: buffer.length,
      preview: previewPayload('patch', resolved.relative,
        { sha256: currentHash, bytes: current.size }, { sha256: afterHash, bytes: buffer.length },
        { replacedBytes: Buffer.byteLength(before), insertedBytes: Buffer.byteLength(after) }) };
  }

  function move(repoRoot, sourcePath, destinationPath, expectedSha256) {
    const source = resolveScopedPath(repoRoot, sourcePath, { fsImpl, mustExist: true, allowRoot: false, allowSymlinkLeaf: true });
    const destination = resolveScopedPath(repoRoot, destinationPath, { fsImpl, mustExist: false, allowRoot: false });
    if (fsImpl.existsSync(destination.absolute)) throw fileError('MACHINE_FILE_EXISTS', 'Move destination must be absent.');
    const sourceStat = fsImpl.lstatSync(source.absolute);
    let digest = null;
    if (sourceStat.isFile()) {
      digest = hashFile(fsImpl, source.absolute, sourceStat, { strict: true });
      assertExpectedHash(digest, expectedSha256);
    } else if (!sourceStat.isDirectory()) {
      throw fileError('MACHINE_FILE_MOVE_TYPE', 'Only regular files or directories can be moved.');
    }
    const parent = destination.api.dirname(destination.absolute);
    if (!fsImpl.existsSync(parent) || !fsImpl.lstatSync(parent).isDirectory())
      throw fileError('MACHINE_FILE_PARENT_MISSING', 'Move destination parent must already exist.');
    fsImpl.renameSync(source.absolute, destination.absolute);
    return { source: toSlash(source.relative), destination: toSlash(destination.relative), sha256: digest,
      preview: { kind: 'move', source: toSlash(source.relative), destination: toSlash(destination.relative), sha256: digest } };
  }

  function remove(repoRoot, relativePath, expectedSha256) {
    const resolved = resolveScopedPath(repoRoot, relativePath, { fsImpl, mustExist: true, allowRoot: false, allowSymlinkLeaf: true });
    const item = fsImpl.lstatSync(resolved.absolute);
    let digest = null;
    if (item.isFile()) {
      digest = hashFile(fsImpl, resolved.absolute, item, { strict: true });
      assertExpectedHash(digest, expectedSha256);
      fsImpl.unlinkSync(resolved.absolute);
    } else if (item.isSymbolicLink()) {
      const target = fsImpl.readlinkSync(resolved.absolute);
      digest = sha256(Buffer.from(`symlink:${target}`));
      assertExpectedHash(digest, expectedSha256);
      fsImpl.unlinkSync(resolved.absolute);
    } else if (item.isDirectory()) {
      const children = fsImpl.readdirSync(resolved.absolute);
      if (children.length) throw fileError('MACHINE_FILE_DIRECTORY_NOT_EMPTY', 'Directory deletion is restricted to empty directories.');
      if (String(expectedSha256 || '') !== sha256(Buffer.from('empty-directory')))
        throw fileError('MACHINE_FILE_HASH_REQUIRED', 'Empty-directory deletion requires the exact empty-directory digest.');
      digest = sha256(Buffer.from('empty-directory'));
      fsImpl.rmdirSync(resolved.absolute);
    } else throw fileError('MACHINE_FILE_DELETE_TYPE', 'Unsupported filesystem object type.');
    return { path: toSlash(resolved.relative), sha256: digest,
      preview: { kind: 'delete', path: toSlash(resolved.relative), before: { sha256: digest, bytes: item.isFile() ? item.size : null }, after: null } };
  }

  return { stat, list, tree, read, search, create, write, patch, move, remove };
}

module.exports = {
  MAX_PATH_CHARS,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  MAX_HASH_BYTES,
  MAX_SCAN_BYTES,
  MAX_LIST_ENTRIES,
  MAX_TREE_ENTRIES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_RESULTS,
  SKIP_DIRS,
  cleanRelative,
  resolveScopedPath,
  operationDigest,
  createFilesystemBroker
};
