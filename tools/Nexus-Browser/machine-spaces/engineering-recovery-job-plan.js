'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { cleanCommand } = require('./approval-broker');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BRANCH = 'eve/nexus-machine-spaces';

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function sameDirectory(a, b) {
  const normalize = (value) => path.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}
function relativeFile(value, root, fsImpl = fs) {
  const raw = String(value || '');
  if (!raw || raw.length > 240 || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/')
      || raw.split('/').some((part) => !part || part === '.' || part === '..'))
    throw fault('MACHINE_RECOVERY_BAD_PATH', 'Recovery files must be bounded repository-relative paths.');
  const candidate = path.resolve(root, ...raw.split('/'));
  if (!candidate.startsWith(root + path.sep) || !fsImpl.existsSync(candidate)
      || fsImpl.lstatSync(candidate).isSymbolicLink() || !fsImpl.statSync(candidate).isFile())
    throw fault('MACHINE_RECOVERY_BAD_PATH', `Recovery file is unavailable or unsafe: ${raw}`);
  return raw;
}
function psLiteral(value) {
  const raw = String(value);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(raw))
    throw fault('MACHINE_RECOVERY_BAD_ARGUMENT', 'Recovery argument contains a control character.');
  return `'${raw.replaceAll("'", "''")}'`;
}
function createEngineeringRecoveryJobPlan(input = {}, { repoRoot = DEFAULT_ROOT, fsImpl = fs } = {}) {
  const root = fsImpl.realpathSync(repoRoot);
  const target = input.target;
  if (!target || !['powershell', 'pwsh'].includes(target.type) || !sameDirectory(target.cwd, root))
    throw fault('MACHINE_RECOVERY_TARGET_INVALID', 'Use a Nexus-managed PowerShell terminal rooted at this EveOS checkout.');
  const runId = String(input.runId || '');
  const expectedHead = String(input.expectedHead || '');
  const branch = String(input.branch || BRANCH);
  if (!RUN_ID.test(runId) || !SHA.test(expectedHead) || branch !== BRANCH)
    throw fault('MACHINE_RECOVERY_BAD_PLAN', 'Require a bounded run ID, exact Git HEAD and the authorized Machine Spaces branch.');
  if (input.retrySafety !== 'idempotent')
    throw fault('MACHINE_RECOVERY_RETRY_UNSAFE', 'Automatic recovery requires an explicit idempotent retry contract.');
  const originalCommand = cleanCommand(String(input.command || ''));
  if (!originalCommand || originalCommand.length > 4000)
    throw fault('MACHINE_RECOVERY_COMMAND_INVALID', 'Recovery command must be non-empty and at most 4000 characters.');
  const repairInput = input.repairFiles;
  if (!Array.isArray(repairInput) || repairInput.length < 1 || repairInput.length > 16)
    throw fault('MACHINE_RECOVERY_BAD_FILES', 'Authorize one to 16 exact repair files.');
  const repairFiles = repairInput.map((item) => relativeFile(item, root, fsImpl));
  if (new Set(repairFiles).size !== repairFiles.length)
    throw fault('MACHINE_RECOVERY_BAD_FILES', 'Recovery repair files must be unique.');
  const contextInput = Array.isArray(input.contextFiles) && input.contextFiles.length ? input.contextFiles : repairFiles;
  if (contextInput.length > 24) throw fault('MACHINE_RECOVERY_BAD_FILES', 'At most 24 context files are permitted.');
  const contextFiles = [...new Set(contextInput.map((item) => relativeFile(item, root, fsImpl)))];
  const invariants = Array.isArray(input.invariants)
    ? input.invariants.slice(0, 12).map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (invariants.some((item) => item.length > 400))
    throw fault('MACHINE_RECOVERY_BAD_INVARIANT', 'Recovery invariants must be at most 400 characters each.');
  const maxAttempts = Number(input.maxAttempts ?? 1);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw fault('MACHINE_RECOVERY_BAD_BUDGET', 'Recovery permits one to three bounded repair attempts.');
  const encoded = Buffer.from(originalCommand, 'utf16le').toString('base64');
  const args = ['python', '-B', 'tools/qualification/eve_run.py', '--branch', branch,
    '--expected-head', expectedHead,
    ...repairFiles.flatMap((file) => ['--repair-file', file]),
    ...contextFiles.flatMap((file) => ['--context-file', file]),
    ...invariants.flatMap((value) => ['--invariant', value]),
    '--max-attempts', String(maxAttempts), '--retry-safety', 'idempotent',
    '--', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  const command = '& ' + args.map(psLiteral).join(' ');
  const commandDigest = createHash('sha256').update(command).digest('hex');
  return Object.freeze({ runId, branch, expectedHead, command, commandDigest, originalCommand,
    metadata: Object.freeze({ schema: 'eveos.machine-spaces.recovery-authority.v1', runId, expectedHead,
      retrySafety: 'idempotent', repairFiles, contextFiles, invariants, maxAttempts }) });
}

module.exports = { BRANCH, createEngineeringRecoveryJobPlan, relativeFile, psLiteral, fault };
