'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');

const MAX_COMMAND_CHARS = 16000;
const DEFAULT_TTL_MS = 60000;
const HIGH_RISK = /(?:^|[\s;&|])(rm|rmdir|rd|del|erase|format|diskpart|shutdown|remove-item|clear-content|stop-computer|restart-computer)(?:\s|$)|git\s+(?:reset\s+--hard|clean\s+-[^\s]*[fd])|(?:^|[^>])>{1,2}\s*[^&]/i;

function cleanCommand(value) {
  const command = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!command || command.length > MAX_COMMAND_CHARS || command.includes('\0')) {
    const error = new Error('Command must be nonempty, text-only, and at most 16,000 characters.');
    error.code = 'MACHINE_BAD_COMMAND';
    throw error;
  }
  return command;
}

function commandDigest(command) {
  return createHash('sha256').update(String(command)).digest('hex');
}

function classifyRisk(command) {
  return HIGH_RISK.test(command) ? 'high' : 'os-user-wide';
}

function createApprovalBroker({
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  idFactory = () => `machine-approval-${randomUUID()}`,
  challengeFactory = () => randomBytes(3).toString('hex').toUpperCase()
} = {}) {
  const pending = new Map();

  function prune() {
    const stamp = now();
    for (const [id, record] of pending) if (record.expiresAt <= stamp) pending.delete(id);
  }

  function prepare(input = {}) {
    prune();
    const ownerId = String(input.ownerId || '');
    const targetId = String(input.targetId || '');
    const requestId = String(input.requestId || '');
    if (!ownerId || !targetId || !requestId) {
      const error = new Error('Approval owner, request, and terminal identity are required.');
      error.code = 'MACHINE_BAD_APPROVAL';
      throw error;
    }
    const command = cleanCommand(input.command);
    const risk = classifyRisk(command);
    const record = {
      approvalId: idFactory(),
      ownerId,
      targetId,
      requestId,
      command,
      commandDigest: commandDigest(command),
      commandSummary: command.replace(/\s+/g, ' ').slice(0, 240),
      risk,
      challenge: risk === 'high' ? challengeFactory() : '',
      context: input.context || null,
      createdAt: now(),
      expiresAt: now() + ttlMs
    };
    pending.set(record.approvalId, record);
    return {
      approvalId: record.approvalId,
      targetId,
      requestId,
      commandDigest: record.commandDigest,
      commandSummary: record.commandSummary,
      risk,
      challenge: record.challenge,
      expiresAt: record.expiresAt
    };
  }

  function decide({ ownerId, approvalId, decision, challenge = '' } = {}) {
    prune();
    const record = pending.get(String(approvalId || ''));
    if (!record || record.ownerId !== String(ownerId || '')) {
      const error = new Error('This one-time approval is missing, expired, or belongs to another local owner.');
      error.code = 'MACHINE_APPROVAL_INVALID';
      throw error;
    }
    if (decision === 'deny') {
      pending.delete(record.approvalId);
      return { allowed: false, record };
    }
    if (decision !== 'allow-once') {
      const error = new Error('Only allow-once or deny is accepted for arbitrary shell execution.');
      error.code = 'MACHINE_APPROVAL_DECISION';
      throw error;
    }
    if (record.risk === 'high' && String(challenge).trim().toUpperCase() !== record.challenge) {
      const error = new Error('High-risk command challenge did not match; nothing executed.');
      error.code = 'MACHINE_APPROVAL_CHALLENGE';
      throw error;
    }
    pending.delete(record.approvalId);
    return { allowed: true, record };
  }

  return {
    prepare,
    decide,
    peek: (approvalId) => pending.get(String(approvalId || '')) || null,
    pendingCount: () => (prune(), pending.size)
  };
}

module.exports = {
  MAX_COMMAND_CHARS,
  DEFAULT_TTL_MS,
  cleanCommand,
  commandDigest,
  classifyRisk,
  createApprovalBroker
};
