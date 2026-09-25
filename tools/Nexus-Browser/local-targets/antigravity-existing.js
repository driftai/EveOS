const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const consoleHelper = require('./console-helper-transport');
const {
  cleanScreenLine,
  cleanReplyLines,
  screenLines,
  isTerminalWidgetLine,
  looksReadyForInput,
  extractVisibleReply,
  mergeVisibleReply,
  findPromptResponseStart,
  extractReadyStructuredReply,
  returnedPromptBoundary,
  selectReadyReply
} = require('./terminal-reply-parser');
const { dataDir } = require('../runtime-config');

const TARGET_PREFIX = 'local:antigravity-existing:';
const TARGET_TYPE_ID = 'terminal-agent';
const INBOX_DIR = path.join(dataDir(), 'inbox');

function isSafePasteCandidate(text) {
  const raw = String(text || '');
  if (raw.length >= 1500) return true;
  if (raw.includes('```')) return true;
  if (/\r?\n/.test(raw.trim())) return true;
  return false;
}

function sanitizeRequestId(requestId) {
  return String(requestId || 'prompt').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function writeInboxPayload(requestId, text, { inboxDir = INBOX_DIR, fsImpl = fs } = {}) {
  const sanitized = sanitizeRequestId(requestId);
  const fileName = `${sanitized}.md`;
  if (!fsImpl.existsSync(inboxDir)) fsImpl.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.resolve(inboxDir, fileName);
  fsImpl.writeFileSync(filePath, String(text || ''), 'utf8');
  return filePath;
}

function removeInboxPayload(filePath, { fsImpl = fs } = {}) {
  try {
    if (filePath && fsImpl.existsSync(filePath)) fsImpl.unlinkSync(filePath);
  } catch {}
}

function pruneInbox(inboxDir = INBOX_DIR, { maxAgeMs = 86400000, fsImpl = fs } = {}) {
  try {
    if (!fsImpl.existsSync(inboxDir)) return;
    const now = Date.now();
    for (const file of fsImpl.readdirSync(inboxDir)) {
      if (!file.endsWith('.md')) continue;
      const fullPath = path.join(inboxDir, file);
      if (now - fsImpl.statSync(fullPath).mtimeMs > maxAgeMs) fsImpl.unlinkSync(fullPath);
    }
  } catch {}
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '').trim()); }
  catch { return fallback; }
}

function isInteractiveAgyProcess(processInfo = {}) {
  const line = String(processInfo.CommandLine || processInfo.commandLine || '').toLowerCase();
  if (!line) return true;
  const nonInteractive = [
    '--input-format', '--output-format', 'stream-json',
    ' --prompt ', ' -p ', ' --json ',
    ' remote-control ', ' --remote-control', ' --bg-updater'
  ];
  return !nonInteractive.some((marker) => line.includes(marker));
}

let lastProcessDiscoveryError = null;
let lastDiscovery = { checkedAt: null, enabled: false, discovered: 0, attached: 0, rejected: [], processDiscoveryError: null };

function discoverAgyProcesses({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  lastProcessDiscoveryError = null;
  if (platform !== 'win32') return [];
  const script = [
    '$items = Get-CimInstance Win32_Process -Filter "Name=\'agy.exe\'" |',
    'Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath;',
    '$json = @($items) | ConvertTo-Json -Compress;',
    'if ($json) { $json } else { "[]" }'
  ].join(' ');
  const result = spawnSyncImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result?.status !== 0) {
    lastProcessDiscoveryError = String(result?.stderr || result?.error?.message || 'PowerShell process enumeration failed.').trim().slice(0, 300);
    return [];
  }
  const parsed = parseJson(result.stdout, null);
  if (parsed == null) {
    lastProcessDiscoveryError = 'PowerShell process enumeration returned no parseable JSON.';
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return items.filter((entry) => entry?.ProcessId && isInteractiveAgyProcess(entry));
}

const runHelper = consoleHelper.runHelper;
const runHelperAsync = consoleHelper.runHelperAsync;

const probeProcess = (pid, options = {}) => runHelper('probe', pid, '', options);
const snapshotProcess = (pid, options = {}) => runHelper('snapshot', pid, '', options);
const snapshotProcessAsync = (pid, options = {}) => runHelperAsync('snapshot', pid, options);
const sendToProcess = (pid, text, options = {}) => runHelper('send', pid, text, options);

function targetFromProcess(processInfo, probe = {}) {
  const pid = Number(processInfo.ProcessId || processInfo.pid);
  return {
    id: `${TARGET_PREFIX}${pid}`,
    targetClassId: 'local-origin',
    targetTypeId: TARGET_TYPE_ID,
    targetTypeName: 'Terminal Agent',
    providerId: 'local-antigravity-existing',
    providerName: 'Antigravity CLI',
    title: `Antigravity CLI · Existing Session · PID ${pid}`,
    detail: 'Attached to an already-running interactive agy terminal. Nexus Browser does not spawn the agent process.',
    transport: 'windows-console-attach',
    sessionOrigin: 'existing',
    sessionOriginName: 'Existing Session',
    pid,
    parentPid: Number(processInfo.ParentProcessId || processInfo.parentPid || 0) || null,
    executablePath: processInfo.ExecutablePath || processInfo.executablePath || null,
    commandLine: processInfo.CommandLine || processInfo.commandLine || null,
    consoleProcesses: Array.isArray(probe.processes) ? probe.processes : [],
    capabilities: { chat: true, captureLatest: true, activity: false, searchResults: false }
  };
}

async function listTargets({
  platform = process.platform,
  discoverImpl = discoverAgyProcesses,
  probeImpl = probeProcess
} = {}) {
  const attach = process.env.NEXUS_BROWSER_ATTACH_EXISTING ?? process.env.BROWSER_AI_BRIDGE_ATTACH_EXISTING ?? '1';
  const enabled = platform === 'win32' && String(attach) !== '0';
  const scan = {
    checkedAt: new Date().toISOString(), enabled, discovered: 0, attached: 0,
    rejected: [], processDiscoveryError: null
  };
  lastDiscovery = scan;
  if (!enabled) return [];

  let candidates;
  try { candidates = discoverImpl({ platform }); }
  catch (error) {
    scan.processDiscoveryError = String(error?.message || error).slice(0, 300);
    return [];
  }
  if (discoverImpl === discoverAgyProcesses) scan.processDiscoveryError = lastProcessDiscoveryError;
  if (!Array.isArray(candidates)) {
    scan.processDiscoveryError = 'Process discovery returned a non-array result.';
    return [];
  }
  scan.discovered = candidates.length;
  const targets = [];
  for (const processInfo of candidates) {
    const pid = Number(processInfo.ProcessId || processInfo.pid);
    let probe;
    try { probe = probeImpl(pid); }
    catch (error) { probe = { ok: false, code: 'CONSOLE_PROBE_THROWN', error: error?.message || String(error) }; }
    if (!probe?.ok) {
      if (scan.rejected.length < 12) scan.rejected.push({
        pid, code: String(probe?.code || 'CONSOLE_PROBE_FAILED'),
        reason: String(probe?.error || 'Console probe did not succeed.').slice(0, 300)
      });
      continue;
    }
    targets.push(targetFromProcess(processInfo, probe));
  }
  scan.attached = targets.length;
  return targets;
}

function getDiscoveryDiagnostics() {
  return { ...lastDiscovery, rejected: lastDiscovery.rejected.map((item) => ({ ...item })) };
}

const ownsTarget = (id) => String(id || '').startsWith(TARGET_PREFIX);
function pidFromTarget(id) {
  if (!ownsTarget(id)) return null;
  const pid = Number(String(id).slice(TARGET_PREFIX.length));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReadySnapshot(pid, {
  snapshotImpl = snapshotProcessAsync,
  sleepImpl = sleep,
  nowImpl = Date.now,
  timeoutMs = 120000,
  pollMs = 500,
  onWait = null
} = {}) {
  const deadline = nowImpl() + timeoutMs;
  let announced = false;
  while (true) {
    const snap = await snapshotImpl(pid);
    if (!snap?.ok) throw new Error(snap?.error || 'Could not read the existing Antigravity terminal.');
    if (looksReadyForInput(snap.text)) return snap;
    if (nowImpl() >= deadline) {
      const error = new Error('Existing Antigravity terminal stayed busy or had draft text; timed out waiting for an empty prompt.');
      error.code = 'LOCAL_EXISTING_NOT_READY';
      throw error;
    }
    if (!announced) {
      announced = true;
      onWait?.();
    }
    await sleepImpl(pollMs);
  }
}

const activePids = new Set();

async function sendPrompt({
  requestId,
  text,
  target,
  emit,
  snapshotImpl = snapshotProcessAsync,
  sendImpl = sendToProcess,
  inboxWriterImpl = writeInboxPayload,
  inboxCleanerImpl = removeInboxPayload,
  inboxPrunerImpl = pruneInbox,
  sleepImpl = sleep,
  nowImpl = Date.now,
  timeoutMs = 25 * 60 * 1000, // 2 minutes to attach + 25 to observe < server's 30-minute absolute lease.
  pollMs = 100,
  stableMs = 1600,
  readyTimeoutMs = 120000,
  readyPollMs = 500,
  retainOnError = false
}) {
  const pid = Number(target?.pid || pidFromTarget(target?.id));
  if (!pid) throw new Error('Existing Antigravity target PID is invalid.');
  if (activePids.has(pid)) throw new Error('That existing Antigravity terminal is already handling a bridge turn.');

  const rawText = String(text || '');
  if (!rawText.trim()) throw new Error('Local agent prompt is empty.');

  let terminalPrompt = '';
  let payloadPath = null;
  let succeeded = false;
  let before = null;

  activePids.add(pid);
  try {
    before = await waitForReadySnapshot(pid, {
      snapshotImpl, sleepImpl, nowImpl,
      timeoutMs: readyTimeoutMs,
      pollMs: readyPollMs,
      onWait: () => emit?.({
        type: 'activity_update',
        requestId,
        text: 'Waiting for the existing Antigravity terminal to return to an empty prompt before dispatch.',
        targetClassId: 'local-origin',
        providerId: target.providerId,
        providerName: target.providerName
      })
    });

    if (isSafePasteCandidate(rawText)) {
    try { inboxPrunerImpl(INBOX_DIR); } catch {}
    payloadPath = inboxWriterImpl(requestId, rawText);
    const quoted = `"${String(payloadPath).replace(/^"|"$/g, '')}"`;
    terminalPrompt = `Read ${quoted} as my exact user message. Preserve its formatting and respond to its contents.`;
    } else {
      terminalPrompt = rawText.replace(/\r?\n+/g, ' ').trim();
    }

    const sent = sendImpl(pid, terminalPrompt);
    if (!sent?.ok) throw new Error(sent?.error || 'Could not write to the existing Antigravity terminal.');
    emit?.({
      type: 'prompt_dispatched', requestId,
      targetClassId: 'local-origin', targetId: target.id,
      providerId: target.providerId, providerName: target.providerName, attachedPid: pid
    });

    let lastScreen = String(before.text || '');
    let lastChangeAt = nowImpl();
    let lastActivityAt = lastChangeAt;
    let lastReply = '';
    let changed = false;
    const deadline = nowImpl() + timeoutMs;

    while (nowImpl() < deadline) {
      await sleepImpl(pollMs);
      const snap = await snapshotImpl(pid);
      if (!snap?.ok) throw new Error(snap?.error || 'Lost the existing Antigravity terminal.');
      const screen = String(snap.text || '');
      if (screen !== lastScreen) {
        changed = true;
        lastScreen = screen;
        lastChangeAt = nowImpl();
        // Real terminal changes keep the 4-minute server idle lease alive during long tool runs.
        // A static/spinning console cannot extend the independent 30-minute absolute lease.
        if (!looksReadyForInput(screen) && lastChangeAt - lastActivityAt >= 30000) {
          lastActivityAt = lastChangeAt;
          emit?.({ type: 'activity_update', requestId, text: 'Existing terminal output changed; still running.',
            targetClassId: 'local-origin', providerId: target.providerId, providerName: target.providerName });
        }
        const visibleReply = extractVisibleReply(before.text, screen, terminalPrompt, lastReply);
        const reply = mergeVisibleReply(lastReply, visibleReply);
        if (reply && reply !== lastReply) {
          lastReply = reply;
          emit?.({
            type: 'response_partial', requestId, text: reply,
            targetClassId: 'local-origin', providerId: target.providerId, providerName: target.providerName
          });
        }
      }

      const stableFor = nowImpl() - lastChangeAt;
      if (changed && stableFor >= stableMs && looksReadyForInput(screen)) {
        const visibleReply = extractVisibleReply(before.text, screen, terminalPrompt, lastReply);
        const structuredReply = extractReadyStructuredReply(screen);
        const accumulatedReply = mergeVisibleReply(lastReply, visibleReply) || visibleReply || lastReply;
        const reply = selectReadyReply(structuredReply, accumulatedReply);
        emit?.({
          type: 'response_final', requestId, text: reply || '(Visible terminal turn completed.)',
          targetClassId: 'local-origin', providerId: target.providerId, providerName: target.providerName,
          attachedPid: pid
        });
        succeeded = true;
        return 0;
      }
    }

    emit?.({
      type: 'error', requestId, code: 'LOCAL_EXISTING_TIMEOUT',
      message: 'Existing terminal exceeded its bounded observation window; capture the original turn without resending.',
      timeoutMs, attachedPid: pid,
      targetClassId: 'local-origin'
    });
    return 1;
  } finally {
    activePids.delete(pid);
    if (payloadPath && (succeeded || !retainOnError)) {
      try { inboxCleanerImpl(payloadPath); } catch {}
    }
  }
}

async function captureLatest({ target, snapshotImpl = snapshotProcessAsync }) {
  const pid = Number(target?.pid || pidFromTarget(target?.id));
  if (!pid) throw new Error('Existing Antigravity target PID is invalid.');
  const snap = await snapshotImpl(pid);
  if (!snap?.ok) throw new Error(snap?.error || 'Could not read the existing Antigravity terminal.');
  if (!looksReadyForInput(snap.text)) {
    const error = new Error('Existing Antigravity terminal is still busy; latest reply is not ready to recover.');
    error.code = 'LOCAL_EXISTING_BUSY';
    throw error;
  }
  const lines = screenLines(snap.text);
  const boundary = returnedPromptBoundary(lines);
  const bounded = boundary >= 0 ? lines.slice(0, boundary) : lines;
  let lastActivity = -1;
  for (let index = 0; index < bounded.length; index += 1) {
    if (isTerminalWidgetLine(bounded[index])) lastActivity = index;
  }
  const activityTail = lastActivity >= 0 ? cleanReplyLines(bounded.slice(lastActivity + 1)).join('\n').trim() : '';
  const text = extractReadyStructuredReply(snap.text) || activityTail;
  if (!text) {
    const error = new Error('No completed Antigravity reply is visible for recovery.');
    error.code = 'LOCAL_EXISTING_CAPTURE_EMPTY';
    throw error;
  }
  return { text, attachedPid: pid };
}

function status(targetId) {
  const pid = pidFromTarget(targetId);
  if (!pid) return null;
  const probe = probeProcess(pid);
  return {
    running: !!probe?.ok,
    busy: activePids.has(pid),
    queued: 0,
    pid,
    sessionOrigin: 'existing',
    attached: !!probe?.ok,
    consoleProcesses: Array.isArray(probe?.processes) ? probe.processes : []
  };
}

module.exports = {
  TARGET_PREFIX,
  TARGET_TYPE_ID,
  INBOX_DIR,
  isSafePasteCandidate,
  sanitizeRequestId,
  writeInboxPayload,
  removeInboxPayload,
  pruneInbox,
  isInteractiveAgyProcess,
  discoverAgyProcesses,
  getDiscoveryDiagnostics,
  probeProcess,
  snapshotProcess,
  snapshotProcessAsync,
  runHelperAsync,
  sendToProcess,
  waitForReadySnapshot,
  targetFromProcess,
  listTargets,
  ownsTarget,
  pidFromTarget,
  cleanScreenLine,
  cleanReplyLines,
  isTerminalWidgetLine,
  looksReadyForInput,
  extractVisibleReply,
  mergeVisibleReply,
  extractReadyStructuredReply,
  selectReadyReply,
  sendPrompt,
  captureLatest,
  status,
  findPromptResponseStart
};
