const antigravityExisting = require('./antigravity-existing');
const antigravityCli = require('./antigravity-cli');
const codexExisting = require('./codex-existing');
const codexCli = require('./codex-cli');
const geminiCli = require('./gemini-cli');
const eveosServiceChats = require('./eveos-service-chats');
const geminiLinkChat = require('./gemini-link-chat');

const TARGET_CLASSES = [
  { id: 'online-origin', name: 'Online-Origin Targets' },
  { id: 'local-origin', name: 'Local-Origin Targets' }
];

const LOCAL_TARGET_TYPES = [
  {
    id: 'terminal-agent',
    name: 'Terminal Agent',
    description: 'Local CLI/agent sessions bridged through the localhost relay.'
  },
  {
    id: 'provider-workspace',
    name: 'Eve-OS Bound Chats',
    description: 'Chats bound to existing EveOS provider workspaces; Nexus ports their active state and capabilities instead of inventing parallel sessions.'
  }
];

const adapters = [eveosServiceChats, geminiLinkChat, codexExisting, antigravityExisting, codexCli, antigravityCli, geminiCli];
const CACHE_MS = Number(process.env.NEXUS_BROWSER_LOCAL_TARGET_CACHE_MS || process.env.BROWSER_AI_BRIDGE_LOCAL_TARGET_CACHE_MS || 600);
let cachedTargets = null;
let cachedAt = 0;
let listInFlight = null;

function normalizeLocalTarget(target = {}) {
  const pid = Number(target.pid || 0) || null;
  return {
    ...target,
    targetClassId: 'local-origin',
    targetTypeId: target.targetTypeId || 'terminal-agent',
    transport: target.transport || 'local-adapter',
    sessionOrigin: target.sessionOrigin || 'local',
    concreteTargetIdentity: target.concreteTargetIdentity || {
      kind: pid ? 'windows-process' : 'adapter-target',
      targetId: String(target.id || ''),
      ...(pid ? { processId: pid } : {}),
      ...(target.executablePath ? { executablePath: String(target.executablePath) } : {})
    },
    capabilities: { ...(target.capabilities || {}) }
  };
}

function publicTargetClasses() {
  return TARGET_CLASSES.map((entry) => ({ ...entry }));
}

function publicLocalTargetTypes() {
  return LOCAL_TARGET_TYPES.map((entry) => ({ ...entry }));
}

function targetPriority(target) {
  if (target.sessionOrigin === 'existing') return 0;
  if (target.sessionOrigin === 'spawned') return 1;
  if (target.providerId === 'local-gemini-cli') return 3;
  return 2;
}

function preferLocalTargets(targets, env = process.env) {
  let result = [...targets];
  const showLegacy = env.NEXUS_BROWSER_SHOW_LEGACY_GEMINI_CLI ?? env.BROWSER_AI_BRIDGE_SHOW_LEGACY_GEMINI_CLI;
  if (String(showLegacy || '') !== '1') {
    const hasAntigravity = result.some((target) => String(target.providerId || '').startsWith('local-antigravity'));
    if (hasAntigravity) result = result.filter((target) => target.providerId !== 'local-gemini-cli');
  }
  return result.sort((a, b) => targetPriority(a) - targetPriority(b));
}

async function adapterTargets(adapter) {
  if (typeof adapter.listTargets === 'function') {
    const targets = await adapter.listTargets();
    return Array.isArray(targets) ? targets.filter(Boolean).map(normalizeLocalTarget) : [];
  }
  if (typeof adapter.publicTarget === 'function') {
    const target = await adapter.publicTarget();
    return target ? [normalizeLocalTarget(target)] : [];
  }
  return [];
}

async function listLocalTargets({ force = false, now = Date.now() } = {}) {
  if (!force && cachedTargets && now - cachedAt < CACHE_MS) return cachedTargets.map((target) => ({ ...target }));
  if (!force && listInFlight) return listInFlight;
  listInFlight = (async () => {
    const targets = [];
    for (const adapter of adapters) {
      try { targets.push(...await adapterTargets(adapter)); }
      catch {}
    }
    cachedTargets = preferLocalTargets(targets);
    cachedAt = Date.now();
    return cachedTargets.map((target) => ({ ...target }));
  })().finally(() => { listInFlight = null; });
  return listInFlight;
}

async function getLocalTarget(targetId) {
  const targets = await listLocalTargets();
  return targets.find((target) => target.id === targetId) || null;
}

function adapterOwnsTarget(adapter, targetId) {
  if (adapter.TARGET_ID === targetId) return true;
  try { return !!adapter.ownsTarget?.(targetId); }
  catch { return false; }
}

function adapterForTarget(targetId) {
  return adapters.find((adapter) => adapterOwnsTarget(adapter, targetId)) || null;
}

function getLocalTargetStatus(targetId) {
  const adapter = adapterForTarget(targetId);
  try { return adapter?.status?.(targetId) || null; }
  catch { return null; }
}

async function captureLocalLatest({ targetId }) {
  if (!targetId) throw new Error('No Local-Origin target is selected.');
  const target = await getLocalTarget(targetId);
  if (!target) throw new Error('Selected Local-Origin target is no longer available.');
  const adapter = adapterForTarget(target.id);
  if (!adapter?.captureLatest) {
    const error = new Error('Local target adapter does not support latest-reply capture.');
    error.code = 'LOCAL_CAPTURE_UNSUPPORTED';
    throw error;
  }
  const result = await adapter.captureLatest({ target });
  return { ...result, target };
}

async function sendLocalPrompt({ targetId, requestId, text, emit, correlation = null }) {
  if (!targetId) throw new Error('No Local-Origin target is selected.');
  const target = await getLocalTarget(targetId);
  if (!target) throw new Error('Selected Local-Origin target is no longer available.');

  const adapter = adapterForTarget(target.id);
  if (!adapter?.sendPrompt) throw new Error('Local target adapter cannot send prompts.');

  emit?.({
    type: 'prompt_accepted',
    requestId,
    targetClassId: 'local-origin',
    targetId: target.id,
    providerId: target.providerId,
    providerName: target.providerName,
    sessionOrigin: target.sessionOrigin || null,
    ...(correlation ? { correlation: { ...correlation } } : {})
  });

  await adapter.sendPrompt({ requestId, text, target, emit, correlation: correlation || {} });
}

function discoveryDiagnostics() {
  return { antigravityExisting: antigravityExisting.getDiscoveryDiagnostics() };
}

function invalidateLocalTargetCache() {
  cachedTargets = null;
  cachedAt = 0;
}

function stopLocalTargets() {
  invalidateLocalTargetCache();
  for (const adapter of adapters) {
    try { adapter.stop?.(); } catch {}
  }
}

module.exports = {
  TARGET_CLASSES,
  LOCAL_TARGET_TYPES,
  publicTargetClasses,
  publicLocalTargetTypes,
  normalizeLocalTarget,
  targetPriority,
  preferLocalTargets,
  adapterForTarget,
  listLocalTargets,
  getLocalTarget,
  getLocalTargetStatus,
  captureLocalLatest,
  sendLocalPrompt,
  invalidateLocalTargetCache,
  discoveryDiagnostics,
  stopLocalTargets
};