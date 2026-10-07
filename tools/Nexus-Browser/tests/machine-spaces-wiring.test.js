'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Base Mode exposes managed Terminal targets and loads Machine Spaces after Dex', () => {
  const html = read('public/index.html');
  for (const id of ['terminalTargetControls', 'terminalTypeSelect', 'terminalTargetSelect',
    'createTerminalTarget', 'connectTerminalTarget', 'interruptTerminal', 'stopTerminalTarget',
    'dexMachineSpaces', 'machineSpaceSelect', 'machineAttachTarget', 'machineSpaceRequests']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('/machine-spaces-ui.js') > html.indexOf('/dex-mode.js'));
  assert.match(html, /Existing external terminals are not attached/);
  assert.match(html, /folder is context, not a security sandbox/i);
});

test('Machine Spaces UI intercepts terminal sends, requires local approval and pages bounded output', () => {
  const source = read('public/machine-spaces-ui.js');
  assert.match(source, /stopImmediatePropagation\(\)/);
  assert.match(source, /machine_prepare_command/);
  assert.match(source, /machine_approve_command/);
  assert.match(source, /decision: 'allow-once'/);
  assert.match(source, /machine_output_page/);
  assert.match(source, /Load more/);
  assert.match(source, /BrowserAiBridgeWorkspaceHandoff/);
  assert.doesNotMatch(source, /eval\(|new Function\(/);
});

test('server owns managed terminal lifecycle and keeps room Machine Spaces server-authoritative', () => {
  const server = read('server.js');
  const merge = read('dex/server-state-merge.js');
  assert.match(server, /createMachineSpacesController/);
  assert.match(server, /machineSpaces\.handle\(ws, msg\)/);
  assert.match(server, /machineCommandRouter: machineSpaces\.providerControl/);
  assert.match(server, /machineSpaces\.stop\(\)/);
  assert.match(merge, /machineSpaces: serverRoom\.machineSpaces/);
});

test('all provider command surfaces agree on the four terminal operations', () => {
  const protocol = require('../public/dex-protocol');
  const browser = require('../public/dex-provider-control');
  const content = require('../extension/content/dex-provider-control');
  for (const action of ['terminal_targets', 'terminal_exec', 'terminal_status', 'terminal_output']) {
    assert.equal(protocol.PROVIDER_CONTROL_ACTIONS.has(action), true, action);
    assert.equal(browser.ACTIONS.has(action), true, action);
    assert.equal(content.ACTIONS.has(action), true, action);
  }
  assert.equal(browser.MUTATING_ACTIONS.has('terminal_exec'), true);
});

test('Machine Spaces never relies on native dialogs that a sandboxed EveOS iframe blocks', () => {
  const html = read('public/index.html');
  const source = read('public/machine-spaces-ui.js');
  assert.doesNotMatch(source, /globalThis\.(confirm|prompt|alert)\(|window\.(confirm|prompt|alert)\(/);
  assert.match(source, /BrowserAiBridgeMachineDialog/);
  assert.ok(html.indexOf('/machine-dialog.js') > -1 && html.indexOf('/machine-dialog.js') < html.indexOf('/machine-spaces-ui.js'));
  for (const id of ['machineNewTerminalType', 'machineNewTerminalCwd', 'machineNewTerminal', 'machineRefreshTerminals'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(source, /machine_create_target/);
});
