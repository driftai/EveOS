'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dataDir } = require('../runtime-config');
const {
  resolveCodexLaunch, codexSettings, execTurn, discoverCodexProcesses,
  resumedThreadId, queueAndCapture
} = require('./codex-common');

const { ensureCodexDispatch } = require('./codex-quota');
const SPAWNED_ID = 'local:codex-cli:spawned';
const STATE_FILE = path.join(dataDir(), 'codex-spawned-session.json');
const active = new Set();

function localWorkspace(env = process.env) {
  const configured = String(env.NEXUS_BROWSER_LOCAL_CWD || env.BROWSER_AI_BRIDGE_LOCAL_CWD || '').trim();
  return configured ? path.resolve(configured) : path.resolve(__dirname, '..', '..');
}

function publicTargets(launch = resolveCodexLaunch()) {
  if (!launch) return [];
  const settings = codexSettings();
  return [{
    id: SPAWNED_ID, targetClassId: 'local-origin', targetTypeId: 'terminal-agent',
    targetTypeName: 'Terminal Agent', providerId: 'local-codex-spawned', providerName: 'ChatGPT (Codex CLI)',
    title: 'ChatGPT (Codex CLI) · Spawned Terminal',
    detail: `Nexus-owned persistent Codex terminal (${settings.model}, ${settings.effort} effort). First message creates and opens the visible terminal; later messages use its exact thread ID.`,
    transport: 'codex-queue-rollout', sessionOrigin: 'spawned', sessionOriginName: 'Spawned Terminal',
    workspace: localWorkspace(), capabilities: { chat: true, captureLatest: false, activity: true, searchResults: false }
  }];
}

async function listTargets() { return publicTargets(); }
const ownsTarget = (id) => id === SPAWNED_ID;

function readState({ stateFile = STATE_FILE } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return value?.threadId ? value : null;
  } catch { return null; }
}

function writeState(value, { stateFile = STATE_FILE } = {}) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, stateFile);
}

function threadProcess(threadId, processes = discoverCodexProcesses()) {
  return processes.find((processInfo) => resumedThreadId(processInfo) === String(threadId || '').toLowerCase()) || null;
}

function openVisibleTerminal({ platform = process.platform, threadId, cwd, launch = resolveCodexLaunch(), settings = codexSettings(), spawnSyncImpl = spawnSync } = {}) {
  if (platform !== 'win32' || !launch || !threadId) return false;
  const script = [
    'Start-Process -FilePath $env:NEXUS_CODEX_EXE',
    '-ArgumentList @("resume",$env:NEXUS_CODEX_THREAD,"--include-non-interactive","--no-alt-screen","-m",$env:NEXUS_CODEX_MODEL,"-c",("model_reasoning_effort=" + $env:NEXUS_CODEX_EFFORT),"-s",$env:NEXUS_CODEX_SANDBOX,"-a","never","-C",$env:NEXUS_CODEX_CWD)',
    '-WorkingDirectory $env:NEXUS_CODEX_CWD -WindowStyle Normal'
  ].join(' ');
  const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: {
      ...process.env, NEXUS_CODEX_EXE: launch.command, NEXUS_CODEX_THREAD: threadId,
      NEXUS_CODEX_MODEL: settings.model, NEXUS_CODEX_EFFORT: settings.effort,
      NEXUS_CODEX_SANDBOX: settings.sandbox, NEXUS_CODEX_CWD: cwd,
      TERM: process.env.NEXUS_BROWSER_CODEX_TERM || 'xterm-256color'
    }
  });
  return result?.status === 0;
}

function emitPartial(emit, requestId, target, text) {
  emit?.({ type: 'response_partial', requestId, text, targetClassId: 'local-origin', providerId: target.providerId, providerName: target.providerName });
}

function emitFinal(emit, requestId, target, text, threadId = null) {
  emit?.({ type: 'response_final', requestId, text, targetClassId: 'local-origin', providerId: target.providerId, providerName: target.providerName, ...(threadId ? { conversationId: threadId } : {}) });
}

async function sendSpawned({ requestId, text, target, emit, execImpl = execTurn, queueImpl = queueAndCapture }) {
  let state = readState();
  if (!state) {
    const result = await execImpl({ prompt: text, ephemeral: false, cwd: target.workspace, onText: (value) => emitPartial(emit, requestId, target, value) });
    if (!result.threadId) throw new Error('Codex completed without exposing its exact thread ID.');
    state = { threadId: result.threadId, cwd: target.workspace, createdAt: new Date().toISOString() };
    writeState(state);
    openVisibleTerminal({ threadId: state.threadId, cwd: state.cwd });
    emitFinal(emit, requestId, target, result.text, state.threadId);
    return 0;
  }
  if (!threadProcess(state.threadId)) {
    openVisibleTerminal({ threadId: state.threadId, cwd: state.cwd || target.workspace });
    const deadline = Date.now() + 10000;
    while (!threadProcess(state.threadId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!threadProcess(state.threadId)) {
      throw new Error('The visible ChatGPT terminal did not become ready; the prompt was not queued.');
    }
  }
  const result = await queueImpl({
    threadId: state.threadId, text, cwd: state.cwd || target.workspace,
    emitPartial: (value) => emitPartial(emit, requestId, target, value)
  });
  emitFinal(emit, requestId, target, result.text, state.threadId);
  return 0;
}

async function sendPrompt(args) {
  const id = args?.target?.id;
  if (!ownsTarget(id)) throw new Error('Codex target is unavailable.');
  if (!String(args.text || '').trim()) throw new Error('Local agent prompt is empty.');
  if (active.has(id)) throw new Error('That ChatGPT target is already handling a turn.');
  active.add(id);
  try { await ensureCodexDispatch(); return await sendSpawned(args); }
  finally { active.delete(id); }
}

function status(targetId) {
  const state = targetId === SPAWNED_ID ? readState() : null;
  const processInfo = state ? threadProcess(state.threadId) : null;
  return {
    running: !!processInfo,
    busy: active.has(targetId), queued: 0, pid: Number(processInfo?.ProcessId || 0) || null,
    conversationId: state?.threadId || null,
    sessionOrigin: 'spawned', initialized: !!state
  };
}

module.exports = {
  SPAWNED_ID, STATE_FILE, localWorkspace, publicTargets, listTargets, ownsTarget,
  readState, writeState, threadProcess, openVisibleTerminal, sendSpawned, sendPrompt, status
};
