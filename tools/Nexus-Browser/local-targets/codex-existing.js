'use strict';

const {
  discoverCodexProcesses, resumedThreadId, findRolloutFile, queueAndCapture
} = require('./codex-common');

const { ensureCodexDispatch } = require('./codex-quota');
const TARGET_PREFIX = 'local:codex-existing:';
const active = new Set();

function targetFromProcess(processInfo, threadId) {
  const pid = Number(processInfo.ProcessId || processInfo.pid || 0) || null;
  return {
    id: `${TARGET_PREFIX}${threadId}`, targetClassId: 'local-origin', targetTypeId: 'terminal-agent',
    targetTypeName: 'Terminal Agent', providerId: 'local-codex-existing', providerName: 'ChatGPT (Codex CLI)',
    title: `ChatGPT (Codex CLI) · Existing Terminal · PID ${pid}`,
    detail: 'Attached by exact Codex thread ID to an already-running resumed terminal. Nexus does not use console scraping or global keyboard input.',
    transport: 'codex-queue-rollout', sessionOrigin: 'existing', sessionOriginName: 'Existing Terminal',
    pid, parentPid: Number(processInfo.ParentProcessId || 0) || null,
    executablePath: processInfo.ExecutablePath || null, commandLine: processInfo.CommandLine || null,
    conversationId: threadId,
    capabilities: { chat: true, captureLatest: false, activity: true, searchResults: false }
  };
}

async function listTargets({ discoverImpl = discoverCodexProcesses } = {}) {
  const targets = [];
  for (const processInfo of discoverImpl()) {
    const threadId = resumedThreadId(processInfo);
    if (!threadId || !findRolloutFile(threadId)) continue;
    targets.push(targetFromProcess(processInfo, threadId));
  }
  return targets;
}

const ownsTarget = (id) => String(id || '').startsWith(TARGET_PREFIX);
const threadFromTarget = (id) => ownsTarget(id) ? String(id).slice(TARGET_PREFIX.length) : null;

async function sendPrompt({ requestId, text, target, emit, queueImpl = queueAndCapture }) {
  const threadId = target?.conversationId || threadFromTarget(target?.id);
  if (!threadId) throw new Error('Existing Codex target thread ID is invalid.');
  if (!String(text || '').trim()) throw new Error('Local agent prompt is empty.');
  if (active.has(threadId)) throw new Error('That existing ChatGPT terminal is already handling a turn.');
  active.add(threadId);
  try {
    await ensureCodexDispatch();
    const result = await queueImpl({
      threadId, text, cwd: target.workspace || process.cwd(),
      emitPartial: (value) => emit?.({
        type: 'response_partial', requestId, text: value, targetClassId: 'local-origin',
        providerId: target.providerId, providerName: target.providerName
      })
    });
    emit?.({
      type: 'response_final', requestId, text: result.text, targetClassId: 'local-origin',
      providerId: target.providerId, providerName: target.providerName,
      conversationId: threadId, attachedPid: target.pid || null
    });
    return 0;
  } finally { active.delete(threadId); }
}

function status(targetId) {
  const threadId = threadFromTarget(targetId);
  if (!threadId) return null;
  const processInfo = discoverCodexProcesses().find((item) => resumedThreadId(item) === threadId);
  return {
    running: !!processInfo, busy: active.has(threadId), queued: 0,
    pid: Number(processInfo?.ProcessId || 0) || null, conversationId: threadId,
    sessionOrigin: 'existing', attached: !!processInfo
  };
}

module.exports = { TARGET_PREFIX, targetFromProcess, listTargets, ownsTarget, threadFromTarget, sendPrompt, status };
