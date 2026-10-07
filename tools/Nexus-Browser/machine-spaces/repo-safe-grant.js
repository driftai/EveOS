'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const POLICY_ID = 'repo-safe-v1';
const MAX_ROOT_CHARS = 1024;
const SIMPLE_REF = /^[A-Za-z0-9._/@^~+:-]+$/;
const SIMPLE_REMOTE = /^[A-Za-z0-9._-]+$/;
const SAFE_STATUS_FLAGS = new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--ignored']);
const SAFE_FETCH_FLAGS = new Set(['--prune', '--tags', '--no-tags']);
const SAFE_LOG_FLAGS = new Set(['--oneline', '--graph', '--all', '--stat', '--name-only', '--name-status', '--no-merges', '--reverse', '--decorate', '--decorate=short', '--decorate=full', '--decorate=auto', '--decorate=no']);
const SAFE_DIFF_FLAGS = new Set(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--check', '--no-color', '--color', '--color=never', '--color=always', '--word-diff', '--word-diff=plain']);

function grantError(code, message) { return Object.assign(new Error(message), { code }); }
function cleanRoot(value) {
  const root = String(value || '').trim();
  if (!root || root.length > MAX_ROOT_CHARS || root.includes('\0'))
    throw grantError('MACHINE_BAD_GRANT_ROOT', 'Repo-safe grants require one bounded local repository root.');
  return root;
}
function pathApiFor(value) { return /^[A-Za-z]:[\\/]/.test(String(value || '')) ? path.win32 : path; }
function normalized(value, pathApi = pathApiFor(value)) {
  const resolved = pathApi.resolve(cleanRoot(value));
  return resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
}
function inside(root, candidate, pathApi = pathApiFor(root)) {
  const relative = pathApi.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + pathApi.sep) && relative !== '..' && !pathApi.isAbsolute(relative));
}
function realpath(fsImpl, value) {
  const fn = fsImpl.realpathSync?.native || fsImpl.realpathSync;
  return fn.call(fsImpl.realpathSync, value);
}
function resolveRepoRoot(cwd, { fsImpl = fs, pathImpl = null } = {}) {
  let current = realpath(fsImpl, cleanRoot(cwd));
  const pathApi = pathImpl || pathApiFor(current);
  while (true) {
    if (fsImpl.existsSync(pathApi.join(current, '.git'))) return current;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw grantError('MACHINE_REPO_REQUIRED', 'The managed terminal must be inside a Git repository before enabling a repo-safe grant.');
}
function tokenize(command) {
  const text = String(command || '').trim();
  // Auto-approval never accepts shell composition, redirection, substitution, variables, or multi-line input.
  if (!text || /[\r\n;&|<>`$]/.test(text) || /@\(/.test(text)) return null;
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] || '')) index++;
    if (index >= text.length) break;
    const quote = text[index] === '"' || text[index] === "'" ? text[index++] : '';
    let value = '';
    if (quote) {
      while (index < text.length && text[index] !== quote) value += text[index++];
      if (text[index] !== quote) return null;
      index++;
      if (index < text.length && !/\s/.test(text[index])) return null;
    } else {
      while (index < text.length && !/\s/.test(text[index])) {
        if (text[index] === '"' || text[index] === "'") return null;
        value += text[index++];
      }
    }
    if (!value) return null;
    tokens.push(value);
  }
  return tokens;
}
function safePathToken(token, { repoRoot, cwd, fsImpl = fs, mustExist = false } = {}) {
  const raw = String(token || '');
  if (!raw || /[*?\[\]]/.test(raw)) return false;
  const pathApi = pathApiFor(repoRoot);
  if (pathApi.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\\\')) return false;
  const root = normalized(repoRoot, pathApi);
  const base = normalized(cwd, pathApi);
  if (!inside(root, base, pathApi)) return false;
  const lexical = pathApi.resolve(base, raw);
  if (!inside(root, lexical, pathApi)) return false;
  if (!fsImpl.existsSync(lexical)) return !mustExist;
  try {
    return inside(root, normalized(realpath(fsImpl, lexical), pathApi), pathApi);
  } catch { return false; }
}
function result(allowed, reason, extra = {}) { return { allowed, policyId: POLICY_ID, reason, ...extra }; }
function safeGitStatus(args) { return args.every((arg) => SAFE_STATUS_FLAGS.has(arg)); }
function safeGitFetch(args) {
  let remoteSeen = false;
  for (const arg of args) {
    if (SAFE_FETCH_FLAGS.has(arg)) continue;
    if (!remoteSeen && SIMPLE_REMOTE.test(arg)) { remoteSeen = true; continue; }
    return false;
  }
  return true;
}
function safeGitPull(args) {
  if (args[0] !== '--ff-only') return false;
  if (args.length === 1) return true;
  if (args.length === 2) return SIMPLE_REMOTE.test(args[1]);
  return args.length === 3 && SIMPLE_REMOTE.test(args[1]) && SIMPLE_REF.test(args[2]) && !args[2].startsWith('-');
}
function safeRevisionArgs(args, safeFlags, pathContext) {
  let paths = false;
  for (const arg of args) {
    if (arg === '--') { paths = true; continue; }
    if (paths) {
      if (!safePathToken(arg, pathContext)) return false;
      continue;
    }
    if (safeFlags.has(arg) || /^--max-count=\d{1,6}$/.test(arg) || /^-n\d{1,6}$/.test(arg)) continue;
    if (arg.startsWith('-')) return false;
    if (!SIMPLE_REF.test(arg)) return false;
  }
  return true;
}
function safeNodeTest(args, context) {
  if (args[0] !== '--test') return false;
  for (const arg of args.slice(1)) {
    if (/^--test-(?:concurrency=\d{1,4}|shard=\d{1,4}\/\d{1,4}|reporter=(?:spec|dot|tap|junit|lcov)|name-pattern=[A-Za-z0-9 ._:/-]{1,160})$/.test(arg)
      || arg === '--test-only') continue;
    if (arg.startsWith('-') || !safePathToken(arg, { ...context, mustExist: true })) return false;
  }
  return true;
}
function safeReadCommand(tokens, context) {
  const name = tokens[0].toLowerCase();
  const args = tokens.slice(1);
  if (name === 'get-location') return args.length === 0;
  if (name === 'get-childitem') {
    if (!args.length) return true;
    if (args.length === 1) return safePathToken(args[0], { ...context, mustExist: true });
    if (args.length === 2 && ['-path', '-literalpath'].includes(args[0].toLowerCase()))
      return safePathToken(args[1], { ...context, mustExist: true });
    return false;
  }
  if (name === 'get-content') {
    if (args.length === 1) return safePathToken(args[0], { ...context, mustExist: true });
    if (args.length === 2 && ['-path', '-literalpath'].includes(args[0].toLowerCase()))
      return safePathToken(args[1], { ...context, mustExist: true });
    if (args.length === 2 && args[1].toLowerCase() === '-raw')
      return safePathToken(args[0], { ...context, mustExist: true });
    return false;
  }
  return false;
}
function evaluateRepoSafeCommand(command, { repoRoot, cwd, fsImpl = fs } = {}) {
  const root = normalized(repoRoot);
  const working = normalized(cwd);
  const pathApi = pathApiFor(root);
  if (!inside(root, working, pathApi)) return result(false, 'terminal-outside-grant-root');
  const tokens = tokenize(command);
  if (!tokens) return result(false, 'command-not-simple');
  const context = { repoRoot: root, cwd: working, fsImpl };
  const first = tokens[0].toLowerCase();
  if (['get-location', 'get-childitem', 'get-content'].includes(first))
    return result(safeReadCommand(tokens, context), safeReadCommand(tokens, context) ? 'read-only-powershell' : 'read-command-outside-policy');
  if (first === 'npm') return result(tokens.length === 2 && tokens[1].toLowerCase() === 'test', 'npm-test-only');
  if (first === 'node') return result(safeNodeTest(tokens.slice(1), context), 'node-test-only');
  if (first !== 'git' || tokens.length < 2) return result(false, 'command-family-not-granted');
  const verb = tokens[1].toLowerCase(), args = tokens.slice(2);
  if (verb === 'pull') return result(safeGitPull(args), 'git-pull-ff-only');
  if (verb === 'fetch') return result(safeGitFetch(args), 'git-fetch');
  if (verb === 'status') return result(safeGitStatus(args), 'git-status');
  if (verb === 'log') return result(safeRevisionArgs(args, SAFE_LOG_FLAGS, context), 'git-log');
  if (verb === 'diff') return result(safeRevisionArgs(args, SAFE_DIFF_FLAGS, context), 'git-diff');
  return result(false, 'git-verb-not-granted');
}
function createRepoSafeGrant({ repoRoot, targetId, ownerId, now = () => Date.now(), idFactory = () => `machine-grant-${randomUUID()}` } = {}) {
  if (!targetId || !ownerId) throw grantError('MACHINE_BAD_GRANT', 'Grant target and local owner identity are required.');
  return {
    id: idFactory(), policy: POLICY_ID, enabled: true, repoRoot: cleanRoot(repoRoot),
    targetId: String(targetId), createdByOwnerId: String(ownerId), createdAt: new Date(now()).toISOString(),
    revokedAt: null
  };
}
function publicGrant(grant) {
  if (!grant || typeof grant !== 'object') return null;
  return { id: grant.id, policy: grant.policy, enabled: grant.enabled === true, repoRoot: grant.repoRoot,
    targetId: grant.targetId || null, createdAt: grant.createdAt || null, revokedAt: grant.revokedAt || null };
}

module.exports = {
  POLICY_ID,
  tokenize,
  resolveRepoRoot,
  safePathToken,
  evaluateRepoSafeCommand,
  createRepoSafeGrant,
  publicGrant
};
