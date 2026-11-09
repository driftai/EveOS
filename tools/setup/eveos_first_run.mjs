#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { detectEdgeBeta, firstRunSummary, installationArguments, EDGE_BETA_PAGE } from './eveos_first_run_core.mjs';

const args = new Set(process.argv.slice(2));
const valid = new Set(['--check', '--json', '--install-edge-beta', '--help']);
if ([...args].some(arg => !valid.has(arg))) {
    console.error('Unknown option. Use --help for supported options.');
    process.exit(2);
}
if (args.has('--help')) {
    console.log('EveOS first-run capabilities (read-only by default)');
    console.log('  node tools/setup/eveos_first_run.mjs --check');
    console.log('  node tools/setup/eveos_first_run.mjs --check --json');
    console.log('  node tools/setup/eveos_first_run.mjs --install-edge-beta');
    console.log('Installation is optional and always requires interactive confirmation.');
    process.exit(0);
}
if (args.has('--json') && args.has('--install-edge-beta')) {
    console.error('--json is read-only and cannot be combined with installation.');
    process.exit(2);
}

function hasWinget() {
    if (process.platform !== 'win32') return false;
    const probe = spawnSync('winget.exe', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return !probe.error && probe.status === 0;
}
function snapshot() {
    const edgeBeta = detectEdgeBeta();
    return firstRunSummary({ edgeBeta, wingetAvailable: hasWinget() });
}
function printStatus(status) {
    console.log(`EVEOS_FIRST_RUN_PLATFORM ${status.operatingSystem}`);
    console.log(`EVEOS_FIRST_RUN_EDGE_BETA ${status.edgeBetaInstalled ? 'PRESENT' : 'ABSENT'}`);
    console.log(`EVEOS_FIRST_RUN_SPOTIFY_DIRECT ${status.spotifyDirect}`);
    console.log(`EVEOS_FIRST_RUN_WINGET ${status.wingetAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
    console.log('EVEOS_FIRST_RUN_BASE_FEATURES_UNBLOCKED');
    if (!status.edgeBetaInstalled && status.operatingSystem === 'win32') {
        console.log('Optional Spotify Direct setup: node tools/setup/eveos_first_run.mjs --install-edge-beta');
    }
}

let status = snapshot();
if (!args.has('--install-edge-beta')) {
    if (args.has('--json')) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    process.exit(0);
}

if (process.platform !== 'win32') {
    console.error('Spotify Direct Windows Output currently supports Windows only. Other EveOS features remain usable.');
    process.exit(2);
}
if (status.edgeBetaInstalled) {
    console.log('EVEOS_EDGE_BETA_ALREADY_INSTALLED');
    process.exit(0);
}
if (!status.wingetAvailable) {
    console.error(`WinGet unavailable. Install Edge Beta manually from ${EDGE_BETA_PAGE}`);
    process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Edge Beta install requires an interactive terminal and explicit confirmation.');
    process.exit(2);
}
console.log('Optional Microsoft Edge Beta installation for Spotify Direct Windows Output.');
console.log(`Publisher download page: ${EDGE_BETA_PAGE}`);
console.log('WinGet will fetch and install Microsoft.Edge.Beta; Windows may request elevation.');
console.log('EveOS will not alter your default Edge channel or copy Spotify profiles.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
let answer = '';
try { answer = (await rl.question('Type INSTALL to proceed, or anything else to cancel: ')).trim(); }
finally { rl.close(); }
if (answer !== 'INSTALL') {
    console.log('EVEOS_EDGE_BETA_INSTALL_CANCELLED');
    process.exit(0);
}
const install = spawnSync('winget.exe', installationArguments(), { stdio: 'inherit', windowsHide: false });
if (install.error || install.status !== 0) {
    console.error(`EVEOS_EDGE_BETA_INSTALL_FAILED ${install.error?.message || install.status}`);
    process.exit(1);
}
status = snapshot();
if (!status.edgeBetaInstalled) {
    console.error('WinGet returned successfully but Edge Beta is not yet in an EveOS-supported location.');
    console.error('Check installation or restart EveOS; do not enable Spotify Direct until detected.');
    process.exit(1);
}
console.log('EVEOS_EDGE_BETA_INSTALL_CONFIRMED');
console.log('Spotify Direct still requires a user-selected Windows audio endpoint and Spotify authorization.');
