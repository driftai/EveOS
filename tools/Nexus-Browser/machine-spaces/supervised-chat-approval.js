'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const CHAT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const CHALLENGE = /^[A-F0-9]{12}$/;

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function text(value) { return String(value ?? '').trim(); }
function approvalText(jobId, commandDigest, challenge) {
  return `/approve-playwright ${text(jobId)} ${text(commandDigest).slice(0, 12)} ${text(challenge).toUpperCase()}`;
}
function approvalDigest(value) { return createHash('sha256').update(text(value)).digest('hex'); }
function safeEqual(left, right) {
  const a = Buffer.from(text(left).toUpperCase()), b = Buffer.from(text(right).toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}
function createChatApproval({ jobId, commandDigest, now = Date.now, bytes = randomBytes } = {}) {
  const challenge = bytes(6).toString('hex').toUpperCase();
  const requiredText = approvalText(jobId, commandDigest, challenge);
  return {
    schema: 'eveos.machine-spaces.playwright-chat-approval.v1',
    challenge,
    requiredText,
    approvalDigest: approvalDigest(requiredText),
    expiresAt: new Date(now() + CHAT_APPROVAL_TTL_MS).toISOString()
  };
}
function publicChatApproval(stored, now = Date.now) {
  const approval = stored?.chatApproval;
  if (!approval || approval.schema !== 'eveos.machine-spaces.playwright-chat-approval.v1') return null;
  return {
    schema: approval.schema,
    requiredText: approval.requiredText,
    expiresAt: approval.expiresAt,
    expired: Date.parse(approval.expiresAt) <= now()
  };
}
function validateChatApproval({ message, job, stored, now = Date.now } = {}) {
  if (!job || job.kind !== 'playwright-acceptance' || job.state !== 'queued')
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_NOT_QUEUED', 'Chat approval requires one queued registered Playwright job.');
  if (!stored || stored.kind !== 'playwright-acceptance' || stored.commandDigest !== job.commandDigest)
    throw machineError('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'The registered Playwright plan is unavailable or changed.');
  const approval = stored.chatApproval;
  if (!approval || approval.schema !== 'eveos.machine-spaces.playwright-chat-approval.v1')
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_MISSING', 'This job has no local chat approval challenge.');
  if (Date.parse(approval.expiresAt) <= now())
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_EXPIRED', 'The Playwright chat approval expired; prepare a new job or use the local review card.');
  const received = text(message?.approvalText);
  if (!CHALLENGE.test(text(message?.challenge).toUpperCase())
      || !safeEqual(message.challenge, approval.challenge)
      || received !== approval.requiredText
      || approvalDigest(received) !== approval.approvalDigest)
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_INVALID', 'The exact job-specific Playwright approval did not match.');
  if (text(message?.jobId) !== job.jobId || text(message?.roomId) !== job.roomId)
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_SCOPE_MISMATCH', 'The chat approval belongs to another job or Dex room.');
  return {
    method: 'dex-owner-chat',
    approvalDigest: approval.approvalDigest,
    approvedText: approval.requiredText
  };
}

module.exports = {
  CHAT_APPROVAL_TTL_MS,
  approvalText,
  createChatApproval,
  publicChatApproval,
  validateChatApproval
};
