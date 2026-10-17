#!/usr/bin/env node
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createDexStateStore } = require('../dex/state-store');
const { createServerDurability } = require('../dex/server-durability');
const { buildHandoffPacket } = require('../dex/handoff-packet');
const { urls } = require('../runtime-config');
const { parseArgs: parseActiveLaneArgs, verifyActiveLane } = require('./active-lane-handoff');

const ROOT = path.resolve(__dirname, '..');
const DIAGNOSTICS = process.env.NEXUS_BROWSER_DIAGNOSTICS || process.env.BROWSER_AI_BRIDGE_DIAGNOSTICS || urls().diagnostics;

function git(args, { quiet = true } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : 'inherit'
    }).trim();
  } catch {
    return null;
  }
}

function gitState({ fetchOrigin = false } = {}) {
  const fetchOk = fetchOrigin ? git(['fetch', '--quiet', 'origin', 'main']) !== null : null;
  const head = git(['rev-parse', 'HEAD']) || null;
  const branch = git(['branch', '--show-current']) || null;
  const status = git(['status', '--short']) || '';
  const originMain = git(['rev-parse', 'origin/main']) || null;
  return {
    head,
    branch,
    clean: status.length === 0,
    status: status ? status.split(/\r?\n/).filter(Boolean) : [],
    originMain,
    headMatchesOriginMain: !!head && !!originMain && head === originMain,
    originFetchAttempted: fetchOrigin,
    originFetchOk: fetchOrigin ? fetchOk : null,
    originMainFreshness: fetchOrigin && fetchOk ? 'fetched-now' : 'last-known-tracking-ref'
  };
}

function gitHead() {
  return gitState().head;
}

function strictRollover(repoState) {
  const issues = [];
  if (repoState.branch !== 'main') issues.push(`expected main branch, found ${repoState.branch || 'unknown'}`);
  if (!repoState.clean) issues.push('working tree is not clean');
  if (!repoState.originFetchOk) issues.push('could not fetch origin/main for strict rollover verification');
  if (!repoState.headMatchesOriginMain) issues.push('local HEAD does not equal fetched origin/main');
  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    issues
  };
}

function parseArgs(argv = process.argv.slice(2)) { return parseActiveLaneArgs(argv); }

async function liveDiagnostics(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetchImpl(DIAGNOSTICS, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function build({ fetchImpl = globalThis.fetch, verify = false, branch = null, expectedHead = null } = {}) {
  const stateStore = createDexStateStore();
  const durability = createServerDurability().diagnostics();
  const diagnostics = await liveDiagnostics(fetchImpl);
  const repoState = gitState({ fetchOrigin: verify && !branch });
  const packet = buildHandoffPacket({
    snapshot: stateStore.load(),
    diagnostics,
    durability,
    gitHead: repoState.head,
    repoState
  });
  if (verify) packet.rollover = branch
    ? verifyActiveLane(repoState, { branch, expectedHead }, git)
    : strictRollover(repoState);
  return packet;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const packet = await build({ verify: options.verify, branch: options.branch, expectedHead: options.expectedHead });
  console.log(JSON.stringify(packet, null, 2));
  if (options.verify && packet.rollover?.ok !== true) process.exitCode = 2;
  return packet;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      version: 1,
      ok: false,
      code: 'HANDOFF_FAILED',
      message: error.message
    }, null, 2));
    process.exitCode = 2;
  });
}

module.exports = { ROOT, DIAGNOSTICS, git, gitState, gitHead, strictRollover, parseArgs, liveDiagnostics, build, main };
