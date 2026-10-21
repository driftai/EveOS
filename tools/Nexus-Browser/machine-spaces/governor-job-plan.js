'use strict';

// Converts a strictly bounded proposal into the existing supervised terminal and
// governor publisher. No new executor, authorization plane, retry loop, or publisher.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/;
const TIERS = new Set(['small', 'medium', 'complex']);
const COMMIT_MESSAGE = /^[A-Za-z0-9][^\r\n\x00-\x1f]{4,119}$/;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function relative(value, prefix) {
  if (typeof value !== 'string' || value.length > 220 || value.includes('\\') || value.includes('\0'))
    throw fault('MACHINE_GOVERNOR_BAD_PATH', 'Only bounded forward-slash repository-relative paths are accepted.');
  const components = value.split('/');
  if (!components.length || components.some((part) => !SEGMENT.test(part) || part === '.' || part === '..' || part.endsWith(' '))
      || value.startsWith('/') || value.endsWith('/'))
    throw fault('MACHINE_GOVERNOR_BAD_PATH', 'Invalid or unsafe path component.');
  if (prefix && !value.startsWith(prefix))
    throw fault('MACHINE_GOVERNOR_BAD_PATH', 'Path is outside its permitted source or runtime scope.');
  return value;
}
function sameDirectory(a, b) {
  const normalize = (x) => path.normalize(String(x || '')).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}
function token(value) {
  // Windows PowerShell 5 and 7 single-quoted literal. Even with validated input,
  // reject quote/control characters before entering an OS shell.
  if (/[\x00-\x1f\x7f']/u.test(value)) throw fault('MACHINE_GOVERNOR_BAD_ARGUMENT', 'Unsafe shell argument.');
  return `'${value}'`;
}
function createGovernorJobPlan(input = {}, { repoRoot = DEFAULT_ROOT, fsImpl = fs } = {}) {
  const root = fsImpl.realpathSync(repoRoot);
  const runId = String(input.runId || '');
  const expectedHead = String(input.expectedHead || '');
  const tier = String(input.tier || 'medium');
  if (!RUN_ID.test(runId) || !SHA.test(expectedHead) || !TIERS.has(tier))
    throw fault('MACHINE_GOVERNOR_BAD_PLAN', 'Require a valid run ID, exact 40-character HEAD and permitted model tier.');
  const allowed = input.allowedFiles;
  if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > 24)
    throw fault('MACHINE_GOVERNOR_BAD_FILES', 'One to 24 exact authorized source files must be named.');
  const files = allowed.map((s) => relative(s));
  if (new Set(files).size !== files.length || files.some((s) => s.startsWith('data/runtime/') || s.startsWith('.git/') || s === '.git'))
    throw fault('MACHINE_GOVERNOR_BAD_FILES', 'Duplicate, protected, or runtime files cannot be granted.');
  const preserved = Array.isArray(input.preserveFiles) ? input.preserveFiles.map((s) => relative(s)) : [];
  if (preserved.length > 8 || new Set(preserved).size !== preserved.length
      || preserved.some((file) => files.includes(file) || file.startsWith('data/runtime/') || file.startsWith('.git/')))
    throw fault('MACHINE_GOVERNOR_BAD_PRESERVE_FILES', 'Preserved files must be a small, exact, disjoint repository-relative set.');
  const publish = input.publish === true;
  const commitMessage = String(input.commitMessage || 'feat(nexus): complete governed engineering task').trim();
  if (!COMMIT_MESSAGE.test(commitMessage))
    throw fault('MACHINE_GOVERNOR_BAD_COMMIT_MESSAGE', 'Commit message must be one bounded printable line.');
  const mission = relative(input.mission, 'data/runtime/');
  if (!mission.endsWith('.txt') && !mission.endsWith('.md'))
    throw fault('MACHINE_GOVERNOR_BAD_MISSION', 'Mission must be an existing ignored .txt or .md file.');
  const missionPath = path.join(root, ...mission.split('/'));
  const runtimeRoot = fsImpl.realpathSync(path.join(root, 'data', 'runtime'));
  const realMission = fsImpl.realpathSync(missionPath);
  if (!realMission.startsWith(runtimeRoot + path.sep) || fsImpl.lstatSync(missionPath).isSymbolicLink() || !fsImpl.statSync(realMission).isFile() || fsImpl.statSync(realMission).size > 128 * 1024)
    throw fault('MACHINE_GOVERNOR_BAD_MISSION', 'Mission must be a real regular file inside ignored runtime storage.');
  const missionSha256 = createHash('sha256').update(fsImpl.readFileSync(realMission)).digest('hex');
  const runRelative = `data/runtime/smoke-results/agent-governor/${runId}`;
  if (fsImpl.existsSync(path.join(root, ...runRelative.split('/'))))
    throw fault('MACHINE_GOVERNOR_RUN_EXISTS', 'An existing run is never restarted or overwritten.');
  const target = input.target;
  if (!target || !['powershell', 'pwsh'].includes(target.type) || !sameDirectory(target.cwd, root))
    throw fault('MACHINE_GOVERNOR_TARGET_INVALID', 'Use an exact Nexus-managed PowerShell terminal rooted at the EveOS checkout.');
  const args = [
    'python', '-B', 'tools/qualification/agent_governor.py', 'run',
    '--repo', '.', '--run-dir', runRelative, '--expected-head', expectedHead,
    '--tier', tier, '--mission', mission,
    ...files.flatMap((file) => ['--allow-file', file]),
    ...preserved.flatMap((file) => ['--preserve-file', file]),
    '--commit-message', commitMessage,
    ...(publish ? ['--authorize-publish'] : [])
  ];
  const command = '& ' + args.map(token).join(' '); // Invoke literal executable in PowerShell.
  if (command.length > 4000) throw fault('MACHINE_GOVERNOR_COMMAND_TOO_LONG', 'Governed command exceeds maximum length.');
  const digest = createHash('sha256').update(command).digest('hex');
  const publication = publish ? { branch: 'eve/nexus-machine-spaces', remote: 'origin', commitMessage } : null;
  return Object.freeze({ runId, tier, expectedHead, command, commandDigest: digest, missionSha256,
    allowedFiles: Object.freeze(files), preserveFiles: Object.freeze(preserved), publication: publication && Object.freeze(publication),
    metadata: Object.freeze({ runId, tier, expectedHead, planDigest: digest, publicationRequested: publish }) });
}

module.exports = { createGovernorJobPlan, relative, fault };
