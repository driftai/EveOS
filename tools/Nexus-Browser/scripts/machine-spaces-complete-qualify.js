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

function main() {
  const allLive = runNode(path.join(__dirname, 'machine-spaces-all-qualify.js'), ['--chatgpt-live', '--external-live']);
  const providers = allLive.status === 'PASS'
    ? runNode(path.join(__dirname, 'provider-provenance-qualify.js'))
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

if (require.main === module) main();

module.exports = { statusForExit, aggregateStatus, runNode, main };
