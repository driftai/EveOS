'use strict';

const appTargets = require('../app-targets/manager');
const storage = require('./terminal-relay-storage');
const winapp = require('../app-targets/winapp-runner');

function anchors(identity = {}) {
  return [...new Set([
    ...(Array.isArray(identity.conversationAnchors) ? identity.conversationAnchors : []),
    identity.conversationAnchor
  ].filter(Boolean).map(String))];
}

function identitySummary(target = null) {
  if (!target) return null;
  const identity = target.concreteTargetIdentity || {};
  return {
    id: target.id || null,
    providerId: target.providerId || null,
    providerName: target.providerName || null,
    title: target.title || null,
    pid: identity.processId || target.pid || null,
    windowHandle: identity.windowHandle || target.windowHandle || null,
    conversationTitle: identity.conversationTitle || null,
    conversationAnchor: identity.conversationAnchor || null,
    conversationAnchors: anchors(identity),
    deliveryScope: identity.deliveryScope || null
  };
}

function ageMs(iso) {
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? Math.max(0, Date.now() - at) : null;
}

function compareTitles(stored, live, reliable = appTargets.reliableConversationTitle) {
  const left = String(stored || '').trim();
  const right = String(live || '').trim();
  const leftOk = reliable(left), rightOk = reliable(right);
  if (!leftOk || !rightOk) return 'UNAVAILABLE';
  return left === right ? 'MATCH' : 'CONFLICT';
}

function compareWindow(stored = {}, live = {}) {
  if (!stored.pid || !stored.windowHandle) return 'INCOMPLETE';
  return String(stored.pid) === String(live.pid || '')
    && String(stored.windowHandle) === String(live.windowHandle || '')
    ? 'MATCH' : 'CHANGED';
}

function classify(report) {
  if (!report.stored) return {
    status: 'NO_SELECTION',
    reason: 'No persisted Terminal Relay App-Origin selection exists.'
  };
  if (!report.live) return {
    status: 'APP_UNAVAILABLE',
    reason: 'The persisted App-Origin target is not currently discoverable.'
  };
  if (report.stored.providerId !== report.live.providerId) return {
    status: 'PROVIDER_MISMATCH',
    reason: 'The live target provider no longer matches the persisted selection.'
  };
  if (report.window === 'CHANGED') return {
    status: 'WINDOW_CHANGED',
    reason: 'The ChatGPT process/window identity changed.'
  };
  if (report.syntheticOrIncomplete) return {
    status: 'POISONED_TEST_SELECTION',
    reason: 'Persisted selection is missing real PID/HWND or native conversation proof.'
  };
  if (report.exactAppTargetMatch && report.advanceAppTargetBinding) return {
    status: 'HEALTHY',
    reason: 'Persisted and live App-Origin identities prove continuity.'
  };
  return {
    status: 'CONVERSATION_CONFLICT',
    reason: 'The live native conversation does not prove continuity with the persisted selection.'
  };
}

async function inspectBinding({
  appTargetsApi = appTargets,
  storageApi = storage,
  winappApi = winapp
} = {}) {
  let helper = { available: false };
  try { helper = await winappApi.availability(); } catch (error) {
    helper = { available: false, error: error.message };
  }

  const selection = storageApi.readTargetSelection();
  const storedTarget = selection?.target?.id ? selection.target : null;
  let liveTargets = [];
  let discoveryError = null;
  try { liveTargets = await appTargetsApi.listAppTargets({ force: true }); }
  catch (error) { discoveryError = error.message; }

  const liveTarget = storedTarget
    ? liveTargets.find((target) => String(target.id) === String(storedTarget.id)) || null
    : liveTargets.find((target) => target.providerId === 'chatgpt-desktop') || null;

  const stored = identitySummary(storedTarget);
  const live = identitySummary(liveTarget);
  const storedAnchors = stored?.conversationAnchors || [];
  const liveAnchors = live?.conversationAnchors || [];
  const liveSet = new Set(liveAnchors);
  const overlap = storedAnchors.filter((anchor) => liveSet.has(anchor));
  const hasConversationProof = !!stored?.conversationTitle || storedAnchors.length > 0;
  const syntheticOrIncomplete = !!stored
    && (!stored.pid || !stored.windowHandle || !hasConversationProof);

  let exactAppTargetMatch = false;
  let advanced = null;
  if (storedTarget && liveTarget) {
    try { exactAppTargetMatch = !!appTargetsApi.exactAppTargetMatch(storedTarget, liveTarget); }
    catch {}
    try { advanced = appTargetsApi.advanceAppTargetBinding(storedTarget, liveTarget); }
    catch {}
  }

  const report = {
    helper,
    discoveryError,
    selectedAt: selection?.selectedAt || null,
    selectedAtAgeMs: ageMs(selection?.selectedAt),
    stored,
    live,
    targetIdMatch: !!stored && !!live && stored.id === live.id,
    providerIdMatch: !!stored && !!live && stored.providerId === live.providerId,
    window: compareWindow(stored || {}, live || {}),
    title: compareTitles(
      stored?.conversationTitle,
      live?.conversationTitle,
      appTargetsApi.reliableConversationTitle || appTargets.reliableConversationTitle
    ),
    anchors: {
      stored: storedAnchors.length,
      live: liveAnchors.length,
      overlap: overlap.length,
      overlapValues: overlap
    },
    exactAppTargetMatch,
    advanceAppTargetBinding: !!advanced,
    advanced: identitySummary(advanced),
    syntheticOrIncomplete
  };
  const classification = classify(report);
  report.binding = classification.status;
  report.reason = classification.reason;
  report.ok = classification.status === 'HEALTHY' && !!helper.available;
  if (!helper.available && report.binding === 'HEALTHY') {
    report.binding = 'HELPER_UNAVAILABLE';
    report.reason = 'Native WinApp UI Automation helper is unavailable.';
  }
  return report;
}

function printDoctorReport(report) {
  const stored = report.stored || {}, live = report.live || {};
  console.log('TERMINAL RELAY DOCTOR');
  console.log('---------------------');
  console.log('Provider:', live.providerName || stored.providerName || live.providerId || stored.providerId || 'UNAVAILABLE');
  console.log('Target ID:', report.targetIdMatch ? 'MATCH' : stored.id || live.id ? 'CONFLICT' : 'UNAVAILABLE');
  console.log('Window:', report.window);
  console.log('PID/HWND:', stored.pid || '—', '/', stored.windowHandle || '—',
    '→', live.pid || '—', '/', live.windowHandle || '—');
  console.log('Title:', report.title);
  console.log('Anchors:', report.anchors.stored, 'stored /', report.anchors.live,
    'live /', report.anchors.overlap, 'overlap');
  console.log('Exact match:', report.exactAppTargetMatch ? 'YES' : 'NO');
  console.log('Advance binding:', report.advanceAppTargetBinding ? 'YES' : 'NO');
  console.log('Helper:', report.helper?.available ? 'AVAILABLE' : 'UNAVAILABLE');
  console.log('Binding:', report.binding);
  console.log('Reason:', report.reason);
}

async function main() {
  const report = await inspectBinding();
  printDoctorReport(report);
  if (process.argv.includes('--json')) {
    console.log('');
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = report.ok ? 0 : 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 2;
  });
}

module.exports = {
  anchors,
  identitySummary,
  compareTitles,
  compareWindow,
  classify,
  inspectBinding,
  printDoctorReport
};
