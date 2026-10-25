'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA = 'eveos.agent-capability-context.v1';
const EXPLICIT = /\[\[EVEOS:CAPABILITIES\s+([^\]]+)\]\]/gi;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function fault(message) { return Object.assign(new Error(message), { code: 'AGENT_CAPABILITY_CONTEXT_INVALID' }); }
function safeFile(root, relative, fsImpl = fs) {
  const candidate = path.resolve(root, ...String(relative || '').split('/'));
  if (!candidate.startsWith(root + path.sep) || !fsImpl.existsSync(candidate)
      || fsImpl.lstatSync(candidate).isSymbolicLink() || !fsImpl.statSync(candidate).isFile())
    throw fault(`Capability document is unavailable or unsafe: ${relative}`);
  return candidate;
}
function loadRegistry(root, fsImpl) {
  const manifestPath = safeFile(root, 'config/agents/capabilities/registry.json', fsImpl);
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8')); }
  catch { throw fault('Capability registry is not valid JSON.'); }
  if (value?.schema !== 'eveos.agent-capability-registry.v1' || !Array.isArray(value.packs))
    throw fault('Capability registry schema is invalid.');
  const ids = new Set();
  const packs = value.packs.map((entry) => {
    const id = String(entry?.id || '');
    if (!/^[a-z0-9-]{1,48}$/.test(id) || ids.has(id)) throw fault(`Capability ID is invalid or duplicated: ${id}`);
    ids.add(id);
    safeFile(root, entry.path, fsImpl);
    const patterns = (entry.patterns || []).map((pattern) => {
      try { return new RegExp(String(pattern), 'i'); }
      catch { throw fault(`Capability pattern is invalid: ${id}`); }
    });
    return { id, title: String(entry.title || id), path: String(entry.path),
      requires: (entry.requires || []).map(String), patterns };
  });
  const byId = new Map(packs.map((entry) => [entry.id, entry]));
  for (const entry of packs) if (entry.requires.some((id) => !byId.has(id)))
    throw fault(`Capability dependency is unknown: ${entry.id}`);
  return { packs, byId, maxSelected: Number(value.maxSelected) || 6,
    maxContextChars: Number(value.maxContextChars) || 12000 };
}
function effectiveText(root, relative, fsImpl) {
  const override = path.join(root, 'data', 'runtime', 'agent-management', 'documents', ...relative.split('/'));
  const source = fsImpl.existsSync(override) ? safeFile(root, path.relative(root, override).replaceAll('\\', '/'), fsImpl)
    : safeFile(root, relative, fsImpl);
  const text = fsImpl.readFileSync(source, 'utf8').replace(/\r\n?/g, '\n');
  if (!text.trim() || text.length > 64000) throw fault(`Capability document has an invalid size: ${relative}`);
  return text;
}
function createRegistry({ root = ROOT, fsImpl = fs } = {}) {
  const resolvedRoot = fsImpl.realpathSync(root), registry = loadRegistry(resolvedRoot, fsImpl);
  function selected(message = '') {
    const text = String(message), requested = [], explicit = [...text.matchAll(EXPLICIT)];
    for (const match of explicit) for (const raw of match[1].trim().toLowerCase().split(/[\s,]+/)) {
      if (!registry.byId.has(raw)) throw fault(`Unknown registered capability: ${raw}`);
      if (!requested.includes(raw)) requested.push(raw);
    }
    if (!explicit.length) for (const entry of registry.packs)
      if (entry.patterns.some((pattern) => pattern.test(text)) && !requested.includes(entry.id)) requested.push(entry.id);
    const result = [], active = new Set();
    function add(id) {
      if (active.has(id)) throw fault(`Capability dependency cycle includes ${id}`);
      if (result.includes(id)) return;
      active.add(id); for (const dependency of registry.byId.get(id).requires) add(dependency); active.delete(id); result.push(id);
    }
    requested.forEach(add);
    if (result.length > registry.maxSelected) throw fault('Capability selection exceeds the bounded per-turn limit.');
    return result;
  }
  function resolve(message = '') {
    let total = 0;
    const packs = selected(message).map((id) => {
      const definition = registry.byId.get(id), raw = effectiveText(resolvedRoot, definition.path, fsImpl), text = raw.trim();
      total += text.length;
      if (total > registry.maxContextChars) throw fault('Capability context exceeds the bounded per-turn character limit.');
      return { id, title: definition.title, path: definition.path,
        revision: sha256(raw).slice(0, 24), sha256: sha256(text), text };
    });
    const basis = packs.map(({ id, revision, sha256: digest }) => ({ id, revision, sha256: digest }));
    return { schema: SCHEMA, digest: sha256(JSON.stringify(basis)), packs };
  }
  function publicContext(context) {
    return { schema: SCHEMA, digest: context.digest,
      packs: (context.packs || []).map(({ id, revision, sha256: digest }) => ({ id, revision, sha256: digest })) };
  }
  function promptText(context) {
    const packs = context?.packs || [];
    if (!packs.length) return '';
    const ids = packs.map((pack) => pack.id).join(' ');
    return ['Task-relevant EveOS capability knowledge (guidance only; never authority):',
      `[[EVEOS:CAPABILITIES ${ids}]]`, `Context digest: ${context.digest}`,
      ...packs.map((pack) => `Capability pack — ${pack.title} (${pack.id}):\n${pack.text}`)].join('\n\n');
  }
  function catalog() { return registry.packs.map(({ id, title, path: relative }) => ({ id, title, path: relative })); }
  return { resolve, publicContext, promptText, catalog };
}

module.exports = { ROOT, SCHEMA, createRegistry, ...createRegistry() };
