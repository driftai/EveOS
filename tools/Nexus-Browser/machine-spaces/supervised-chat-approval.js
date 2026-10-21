'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const CHAT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const CHALLENGE = /^[A-F0-9]{12}$/;
const APPROVAL_INTENT = 'single-pending-playwright';
const SUPERVISED_APPROVAL_INTENT = 'single-pending-supervised';
const SHORTHAND = /^(?:\/approve|yes[,.]?\s+go\s+ahead)[.!]?$/i;

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function text(value) { return String(value ?? '').trim(); }
function approvalText(jobId, commandDigest, challenge, kind = 'playwright-acceptance') {
  const command = ['terminal-supervised', 'governor'].includes(kind) ? '/approve-workflow' : '/approve-playwright';
  return `${command} ${text(jobId)} ${text(commandDigest).slice(0, 12)} ${text(challenge).toUpperCase()}`;
}
function approvalDigest(value) { return createHash('sha256').update(text(value)).digest('hex'); }
function safeEqual(left, right) {
  const a = Buffer.from(text(left).toUpperCase()), b = Buffer.from(text(right).toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}
function createChatApproval({ jobId, commandDigest, kind = 'playwright-acceptance', now = Date.now, bytes = randomBytes } = {}) {
  const challenge = bytes(6).toString('hex').toUpperCase();
  const requiredText = approvalText(jobId, commandDigest, challenge, kind);
  return {
    schema: ['terminal-supervised', 'governor'].includes(kind)
      ? 'eveos.machine-spaces.workflow-chat-approval.v1'
      : 'eveos.machine-spaces.playwright-chat-approval.v1',
    challenge,
    requiredText,
    approvalDigest: approvalDigest(requiredText),
    expiresAt: new Date(now() + CHAT_APPROVAL_TTL_MS).toISOString()
  };
}
function publicChatApproval(stored, now = Date.now) {
  const approval = stored?.chatApproval;
  if (!approval || !['eveos.machine-spaces.playwright-chat-approval.v1',
    'eveos.machine-spaces.workflow-chat-approval.v1'].includes(approval.schema)) return null;
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

function validateChatApprovalIntent({ message, job, stored, now = Date.now } = {}) {
  if (![APPROVAL_INTENT, SUPERVISED_APPROVAL_INTENT].includes(text(message?.approvalIntent))
      || !SHORTHAND.test(text(message?.approvalText)))
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_INTENT_INVALID', 'Use /approve or "yes, go ahead" for the single pending Playwright request.');
  if (!job || job.kind !== 'playwright-acceptance' || job.state !== 'queued')
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_NOT_QUEUED', 'Chat approval requires one queued registered Playwright job.');
  if (!stored || stored.kind !== 'playwright-acceptance' || stored.commandDigest !== job.commandDigest)
    throw machineError('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'The registered Playwright plan is unavailable or changed.');
  const approval = stored.chatApproval;
  if (!approval || approval.schema !== 'eveos.machine-spaces.playwright-chat-approval.v1')
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_MISSING', 'This job has no local chat approval challenge.');
  if (Date.parse(approval.expiresAt) <= now())
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_EXPIRED', 'The Playwright chat approval expired; prepare a new job or use the local review card.');
  if (text(message?.roomId) !== job.roomId)
    throw machineError('MACHINE_PLAYWRIGHT_CHAT_SCOPE_MISMATCH', 'The chat approval belongs to another Dex room.');
  return {
    method: 'dex-owner-chat-shorthand',
    approvalDigest: approval.approvalDigest,
    approvedText: text(message.approvalText)
  };
}

function validateWorkflowChatApproval({ message, job, stored, now = Date.now } = {}) {
  if (!job || !['terminal-supervised', 'governor'].includes(job.kind) || job.state !== 'queued')
    throw machineError('MACHINE_WORKFLOW_CHAT_NOT_QUEUED', 'Chat workflow approval requires one queued eligible engineering job.');
  if (!stored?.chatApproval || stored.chatApproval.schema !== 'eveos.machine-spaces.workflow-chat-approval.v1'
      || stored.commandDigest !== job.commandDigest)
    throw machineError('MACHINE_WORKFLOW_PLAN_CHANGED', 'The eligible engineering workflow is unavailable or changed.');
  if (Date.parse(stored.chatApproval.expiresAt) <= now())
    throw machineError('MACHINE_WORKFLOW_CHAT_APPROVAL_EXPIRED', 'The workflow chat approval expired; prepare a new job or use the local review card.');
  const received = text(message?.approvalText);
  const exact = message?.approvalIntent
    ? [APPROVAL_INTENT, SUPERVISED_APPROVAL_INTENT].includes(text(message.approvalIntent)) && SHORTHAND.test(received)
    : CHALLENGE.test(text(message?.challenge).toUpperCase())
      && safeEqual(message.challenge, stored.chatApproval.challenge)
      && received === stored.chatApproval.requiredText
      && approvalDigest(received) === stored.chatApproval.approvalDigest;
  if (!exact || text(message?.roomId) !== job.roomId)
    throw machineError('MACHINE_WORKFLOW_CHAT_APPROVAL_INVALID', 'Workflow approval did not match the exact pending room job.');
  return { method: message?.approvalIntent ? 'dex-owner-chat-workflow-shorthand' : 'dex-owner-chat-workflow',
    approvalDigest: stored.chatApproval.approvalDigest, approvedText: received, workflowApproval: true };
}

module.exports = {
  CHAT_APPROVAL_TTL_MS, APPROVAL_INTENT, SUPERVISED_APPROVAL_INTENT, SHORTHAND,
  approvalText,
  createChatApproval,
  publicChatApproval,
  validateChatApproval,
  validateChatApprovalIntent,
  validateWorkflowChatApproval
};
