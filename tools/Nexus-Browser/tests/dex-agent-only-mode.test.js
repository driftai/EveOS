const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const human = require('../public/dex-human-control.js');

const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mode = fs.readFileSync(path.join(root, 'dex-mode.js'), 'utf8');
const members = fs.readFileSync(path.join(root, 'dex-members.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dex-mode.css'), 'utf8');
const roomView = fs.readFileSync(path.join(root, 'dex-room-view.js'), 'utf8');

function fixture() {
  const calls = {};
  const controls = Object.fromEntries(human.LOCKABLE.map(id => [id, { disabled: false }]));
  const panel = { dataset: {} };
  const label = { textContent: '' };
  const hint = { textContent: '' };
  const toggle = {
    textContent: '', attrs: {}, classes: new Set(),
    addEventListener(type, listener) { calls[type] = listener; },
    setAttribute(name, value) { this.attrs[name] = value; },
    classList: { toggle(name, state) { toggle.classes[state ? 'add' : 'delete'](name); } },
    click() { calls.click(); }
  };
  let relocks = 0; const changes = [];
  const ctl = human.createController({
    panel, label, hint, toggle, controls,
    onRelock() { relocks += 1; }, onChange(enabled) { changes.push(enabled); }
  });
  return { ctl, controls, panel, label, hint, toggle, get relocks() { return relocks; },
    get changes() { return changes; } };
}

const available = { connected: true, controller: true, hasRoom: true,
  busy: false, messageCount: 3, editing: false };

test('agent-only is the default on every controller construction and greys structural controls', () => {
  const ui = fixture();
  ui.ctl.render(available);
  assert.equal(ui.ctl.isEnabled(), false);
  assert.equal(ui.panel.dataset.humanInput, 'disabled');
  assert.equal(ui.label.textContent, 'Agent-Only Mode');
  assert.equal(ui.toggle.attrs['aria-pressed'], 'false');
  assert.equal(ui.toggle.textContent, 'Enable Human Input');
  for (const [id, control] of Object.entries(ui.controls)) {
    assert.equal(control.disabled, true, id + ' should be locked');
  }
  assert.equal(human.LOCKABLE.includes('dexPrompt'), false);
  assert.equal(human.LOCKABLE.includes('dexSend'), false);
  assert.equal(human.LOCKABLE.includes('dexRoomList'), false);
});

test('human unlock enables editing without affecting navigation or room input', () => {
  const ui = fixture();
  ui.toggle.click();
  ui.ctl.render(available);
  assert.equal(ui.ctl.isEnabled(), true);
  assert.equal(ui.panel.dataset.humanInput, 'enabled');
  assert.equal(ui.controls.dexNewRoom.disabled, false);
  assert.equal(ui.controls.dexSaveRoom.disabled, false);
  assert.equal(ui.controls.dexClearChat.disabled, false);
  assert.equal(ui.controls.dexStopRelay.disabled, true);
  assert.equal(ui.controls.dexContinueRelay.disabled, false);
});

test('locking again invokes draft cleanup and a fresh controller always returns locked', () => {
  const ui = fixture();
  ui.toggle.click();
  ui.toggle.click();
  ui.ctl.render(available);
  assert.equal(ui.relocks, 1);
  assert.deepEqual(ui.changes, [true, false]);
  assert.equal(ui.ctl.isEnabled(), false);
  assert.equal(fixture().ctl.isEnabled(), false);
});

test('human unlock still respects runtime standby, reconnect, and busy-room safety', () => {
  const ui = fixture();
  ui.toggle.click();
  ui.ctl.render({ ...available, controller: false });
  assert.equal(ui.controls.dexNewRoom.disabled, true);
  assert.match(ui.hint.textContent, /Claiming the primary editing role/);
  ui.ctl.render({ ...available, connected: false });
  assert.equal(ui.controls.dexSaveRoom.disabled, true);
  ui.ctl.render({ ...available, busy: true });
  assert.equal(ui.controls.dexSaveRoom.disabled, true);
  assert.equal(ui.controls.dexStopRelay.disabled, false);
  assert.equal(ui.controls.dexContinueRelay.disabled, true);
});

test('a stopped room receipt permits editing while destructive history clearing stays fenced', () => {
  const ui = fixture();
  ui.toggle.click();
  ui.ctl.render({ ...available, receiptPending: true });
  assert.equal(ui.controls.dexSaveRoom.disabled, false);
  assert.equal(ui.controls.dexAddMember.disabled, false);
  assert.equal(ui.controls.dexDeleteRoom.disabled, false);
  assert.equal(ui.controls.dexClearChat.disabled, true);
  assert.equal(ui.controls.dexContinueRelay.disabled, true);
});

test('provider commands bypass the browser-only editing gate and human messaging stays available', () => {
  assert.match(mode, /providerControl\.handle\(msg\)/);
  assert.match(mode, /humanInput\.render/);
  assert.match(mode, /onChange: \(enabled\)[\s\S]*dex_request_primary/);
  assert.match(mode, /canHumanEdit\(\)/);
  assert.match(mode, /el\.dexSend\.disabled = !uiConnected/);
  assert.match(roomView, /el\.dexRoomList\.replaceChildren\(\)/);
  assert.match(mode, /roomView\.renderRooms\(\)/);
  assert.doesNotMatch(mode, /el\.dexModePanel\.inert\s*=/);
  assert.doesNotMatch(mode, /runtime\.stopAllRelays\('Base Mode opened'\)/);
  assert.match(members, /canHumanEdit = \(\) => true/);
  assert.match(members, /!canHumanEdit\(\)/);
});

test('mode banner, pulse and script have stable wiring without persistent unlock state', () => {
  assert.match(html, /id="dexControlLabel"[^>]*>Agent-Only Mode/);
  assert.match(html, /id="dexHumanToggle"[^>]*>Enable Human Input/);
  assert.match(html, /\/dex-human-control\.js[\s\S]*\/dex-room-view\.js[\s\S]*\/dex-mode\.js/);
  assert.match(css, /dex-human-input-pulse/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  const source = fs.readFileSync(path.join(root, 'dex-human-control.js'), 'utf8');
  assert.doesNotMatch(source, /(?:session|local)Storage/);
});
