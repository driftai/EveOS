#!/usr/bin/env node
'use strict';
// Worker-specific, observation-only preflight. It never grants a Machine Spaces
// capability, dispatches a model, starts Governor, or publishes source.
// Codex Governor is one executor, not the default for every Dex/TLO task.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BRANCH = 'eve/nexus-machine-spaces';
const SHA = /^[0-9a-f]{40}$/;
const WORKFLOWS = Object.freeze({
  tlo: new Set(['local-agent', 'recovery']),
  codex: new Set(['governor-publication']),
  remote: new Set(['source-review'])
});

function parseArgs(args = []) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--worker', '--workflow', '--expected-head', '--min-remaining'].includes(key)
        || i + 1 >= args.length || String(args[i + 1]).startsWith('--')
        || Object.hasOwn(options, key)) throw Error('Arguments: --worker tlo|codex|remote --workflow local-agent|recovery|governor-publication|source-review --expected-head EXACT_SHA [--min-remaining 15]');
    options[key] = args[i + 1];
  }
  const worker = options['--worker'];
  const workflow = options['--workflow'];
  const expectedHead = options['--expected-head'];
  const minRemaining = options['--min-remaining'] == null ? 15 : Number(options['--min-remaining']);
  if (!Object.hasOwn(WORKFLOWS, worker) || typeof workflow !== 'string' || !SHA.test(expectedHead || '')
      || !Number.isFinite(minRemaining) || minRemaining < 6 || minRemaining > 100)
    throw Error('Explicit recognized worker/workflow, exact expected HEAD and min-remaining >=6 are required. No implicit Codex default.');
  return { worker, workflow, expectedHead, minRemaining };
}

function defaultRun(cmd, args, { cwd = ROOT, timeout = 20000 } = {}) {
  const out = spawnSync(cmd, args, { cwd, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  return { code: out.status == null ? -1 : out.status,
    stdout: String(out.stdout || ''), stderr: String(out.stderr || ''), error: out.error?.code || null };
}
function cleanOutput(result) { return String(result.stdout || '').trim(); }
function attempt(run, cmd, args, cwd) { return run(cmd, args, { cwd, timeout: 20000 }); }
function gitCheck({ run, repoRoot, expectedHead }) {
  const step = (args) => {
    const r = attempt(run, 'git', args, repoRoot);
    if (r.code !== 0) throw Error(`Git ${args[0]} preflight unavailable (${r.error || r.code}); refusing execution.`);
    return cleanOutput(r);
  };
  const branch = step(['branch', '--show-current']);
  const head = step(['rev-parse', 'HEAD']);
  const dirty = step(['status', '--porcelain']);
  const remoteRaw = step(['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`]);
  const matches = remoteRaw.split(/\r?\n/).filter(Boolean);
  const remote = matches.length === 1 && /^([0-9a-f]{40})\s+refs\/heads\/eve\/nexus-machine-spaces$/.test(matches[0])
    ? matches[0].slice(0, 40) : '';
  const ok = branch === BRANCH && head === expectedHead && remote === expectedHead && !dirty;
  return { ok, branch, head, remote, clean: !dirty };
}
function parseTloStatus(raw) {
  const head = raw.match(/^HEAD\s+([0-9a-f]{40})\s*$/m)?.[1] || null;
  const tlo = raw.match(/^TLO\s+(\S+)\s+·\s+canChat=(true|false)\s+·\s+model=([^\r\n]*)$/m);
  const nexus = raw.match(/^NEXUS\s+extension=(connected|ready\/offline|missing)\b/m);
  return { head, tloState: tlo?.[1] || 'unknown', canChat: tlo?.[2] === 'true',
    model: tlo?.[3]?.trim() || null, nexusExtension: nexus?.[1] || 'unknown' };
}
function parseCodexQuota(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const fiveHour = data?.fiveHour?.remainingPercent;
  const weekly = data?.weekly?.remainingPercent;
  if (data?.state !== 'AVAILABLE' || data?.incomplete || data?.reached ||
      typeof fiveHour !== 'number' || typeof weekly !== 'number' ||
      !Number.isFinite(fiveHour) || !Number.isFinite(weekly) ||
      !data?.fiveHour?.resetAt || !data?.weekly?.resetAt) return null;
  return { fiveHour, weekly, fiveHourReset: data.fiveHour.resetAt, weeklyReset: data.weekly.resetAt };
}
function preflight(options, { run = defaultRun, repoRoot = ROOT, node = process.execPath } = {}) {
  const { worker, workflow, expectedHead, minRemaining = 15 } = options;
  const result = { schema: 'eveos.engineering-worker-preflight.v1', worker, workflow,
    status: 'BLOCKED', reason: null, codexQuotaApplicable: worker === 'codex',
    authorityGranted: false, modelDispatched: false, governorStarted: false, publicationAuthorized: false };
  if (!Object.hasOwn(WORKFLOWS, worker) || !WORKFLOWS[worker].has(workflow)) {
    result.reason = worker === 'tlo' && workflow === 'governor-publication'
      ? 'TLO_READY_IS_NOT_CODEX_GOVERNOR: existing Governor publication still launches Codex. No transparent fallback.'
      : 'UNSUPPORTED_WORKER_WORKFLOW: choose a supported explicit worker; no automatic Codex fallback.';
    return result;
  }
  try { result.git = gitCheck({ run, repoRoot, expectedHead }); }
  catch (error) { result.reason = `GIT_PREFLIGHT_UNAVAILABLE: ${error.message}`; return result; }
  if (!result.git.ok) { result.reason = 'BRANCH_HEAD_REMOTE_OR_WORKTREE_CHANGED'; return result; }
  if (worker === 'remote') {
    result.status = 'READY_FOR_REMOTE_SOURCE_REVIEW_ONLY';
    result.reason = 'No local agent, model, or Governor readiness implied.';
    return result;
  }
  if (worker === 'tlo') {
    const snapshot = attempt(run, node, ['tools/runtime/search-monitor-runtime.mjs', 'status'], repoRoot);
    const parsed = parseTloStatus(cleanOutput(snapshot));
    result.tlo = parsed;
    if (snapshot.code !== 0 || parsed.head !== expectedHead || parsed.tloState !== 'ready'
        || parsed.canChat !== true || !parsed.model || parsed.nexusExtension !== 'connected') {
      result.reason = 'TLO_OR_DEX_TRANSPORT_NOT_READY: check Search Monitor, model, Nexus and exact runtime HEAD.';
      return result;
    }
    result.status = 'READY_FOR_TLO_BOUND_WORK';
    result.reason = 'TLO transport/model ready. Machine Spaces authority and explicit owner approval remain separate; Codex Governor publication is NOT authorized.';
    return result;
  }
  const quotaCheck = attempt(run, node,
    ['tools/Nexus-Browser/scripts/codex-quota-cli.js', '--require-fresh', '--min-remaining', String(minRemaining)], repoRoot);
  const quota = parseCodexQuota(cleanOutput(quotaCheck));
  result.codexQuota = quota;
  if (!quota) { result.reason = 'CODEX_QUOTA_UNAVAILABLE_OR_INCOMPLETE'; return result; }
  if (quotaCheck.code !== 0 || quota.fiveHour <= minRemaining || quota.weekly <= minRemaining) {
    result.reason = 'CODEX_QUOTA_BELOW_REQUIRED_HEADROOM';
    return result;
  }
  result.status = 'READY_FOR_CODEX_GOVERNOR_PREFLIGHT';
  result.reason = 'Quota preflight passed. Exact Governor policy, bounded local approval, testing, and publication guards remain mandatory.';
  return result;
}

function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  const result = preflight(o);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.status.startsWith('READY_') ? 0 : 3;
}
if (require.main === module) process.exitCode = main();
module.exports = { parseArgs, parseTloStatus, parseCodexQuota, preflight, gitCheck, main };
