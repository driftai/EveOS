#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function statusForExit(exitCode) {
  return exitCode === 0 ? 'PASS' : exitCode === 2 ? 'BLOCKED' : 'FAIL';
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024
  });
  return {
    status: statusForExit(result.status),
    exitCode: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

function aggregateStatus(sections) {
  if (sections.some((section) => section.status === 'FAIL')) return 'FAIL';
  if (sections.some((section) => section.status === 'BLOCKED')) return 'BLOCKED';
  return 'PASS';
}

function forwardedArgs(argv, valueNames = [], flagNames = []) {
  const forwarded = [];
  for (const name of valueNames) {
    const index = argv.indexOf(name);
    if (index < 0) continue;
    const value = argv[index + 1];
    if (value == null || String(value).startsWith('--')) {
      throw Object.assign(new Error(`${name} requires a value.`), { code: 'QUALIFY_BAD_ARGUMENT' });
    }
    forwarded.push(name, value);
  }
  for (const name of flagNames) {
    if (argv.includes(name)) forwarded.push(name);
  }
  return forwarded;
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) {
    throw Object.assign(new Error(`${name} requires a value.`), { code: 'QUALIFY_BAD_ARGUMENT' });
  }
  return value;
}

function childArgs(argv = process.argv.slice(2)) {
  const shared = forwardedArgs(argv, ['--timeout-ms']);
  const warmTabId = argumentValue(argv, '--warm-tab-id');
  const explicitChatgptTabId = argumentValue(argv, '--chatgpt-tab-id');
  const providerChatgptUrl = argumentValue(argv, '--chatgpt-url');
  const providerChatgptTabId = explicitChatgptTabId || (providerChatgptUrl ? null : warmTabId);
  const allLive = [
    '--chatgpt-live',
    '--external-live',
    ...shared,
    ...forwardedArgs(argv, ['--warm-tab-id'])
  ];
  const providers = [
    ...shared,
    ...forwardedArgs(argv, ['--source-target-id', '--hark-tab-id'], ['--skip-quorum'])
  ];
  if (providerChatgptTabId != null) providers.push('--chatgpt-tab-id', providerChatgptTabId);
  if (providerChatgptUrl != null) providers.push('--chatgpt-url', providerChatgptUrl);
  return { allLive, providers };
}

function main() {
  const args = childArgs();
  const allLive = runNode(path.join(__dirname, 'machine-spaces-all-qualify.js'), args.allLive);
  const providers = allLive.status === 'PASS'
    ? runNode(path.join(__dirname, 'provider-provenance-qualify.js'), args.providers)
    : {
        status: 'BLOCKED', exitCode: 2, stdout: '', stderr: '',
        reason: 'Provider provenance qualification was not started because the deterministic/live Machine Spaces gate did not pass. No provider mutation was attempted.'
      };
  const status = aggregateStatus([allLive, providers]);
  const report = {
    kind: 'machine-spaces-complete-qualification',
    at: new Date().toISOString(),
    status,
    headNote: 'Run from a clean, freshly pulled eve/nexus-machine-spaces worktree. The report does not claim qualification for a different Git HEAD.',
    arguments: {
      warmTabPinned: args.allLive.includes('--warm-tab-id'),
      providerChatgptTabPinned: args.providers.includes('--chatgpt-tab-id'),
      providerChatgptUrlPinned: args.providers.includes('--chatgpt-url'),
      harkTabPinned: args.providers.includes('--hark-tab-id'),
      sourceTargetPinned: args.providers.includes('--source-target-id'),
      quorumSkipped: args.providers.includes('--skip-quorum')
    },
    allLive,
    providers,
    safety: {
      uncertainMutationRetry: false,
      providerQualificationRequiresCommittedReplies: true,
      providerRoomDisposable: true,
      uiManualClicksRequired: false
    }
  };
  process.stdout.write('MACHINE_SPACES_COMPLETE_QUALIFICATION_BEGIN\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('MACHINE_SPACES_COMPLETE_QUALIFICATION_END\n');
  process.exitCode = status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write('MACHINE_SPACES_COMPLETE_QUALIFICATION_BEGIN\n');
    process.stdout.write(JSON.stringify({ status: 'FAIL', code: error.code || error.name, reason: error.message }, null, 2) + '\n');
    process.stdout.write('MACHINE_SPACES_COMPLETE_QUALIFICATION_END\n');
    process.exitCode = 1;
  }
}

module.exports = { statusForExit, aggregateStatus, forwardedArgs, argumentValue, childArgs, runNode, main };
