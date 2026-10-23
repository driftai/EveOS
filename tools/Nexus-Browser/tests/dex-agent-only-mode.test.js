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
  const calls = {}, sent = []; let sequence = 0;
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
    send(payload) { sent.push(payload); return true; }, uid(prefix) { return `${prefix}-${++sequence}`; },
    setTimer() { return 1; }, clearTimer() {},
    onRelock() { relocks += 1; }, onChange(status) { changes.push(status); }
  });
  return { ctl, controls, panel, label, hint, toggle, get relocks() { return relocks; },
    sent, get changes() { return changes; } };
}

const available = { connected: true, controller: true, hasRoom: true,
  roomId: 'room-one', busy: false, messageCount: 3, editing: false };
const lease = () => ({ token: 'lease-one', actorId: 'actor-one', serverEpoch: 'epoch-one', generation: 1,
  roomId: 'room-one', kind: 'human-input', operations: ['state:edit','room:delete','relay:stop','relay:continue'],
  expiresAt: new Date(Date.now() + 60000).toISOString() });
function activate(ui) {
  ui.ctl.render(available); ui.toggle.click();
  ui.ctl.handleMessage({ type: 'dex_human_input_status', requestId: ui.sent.at(-1).requestId, status: 'active', lease: lease() });
}

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
  activate(ui);
  assert.equal(ui.ctl.isEnabled(), true);
  assert.equal(ui.panel.dataset.humanInput, 'enabled');
  assert.equal(ui.label.textContent, 'Human Input Active');
  assert.equal(ui.sent[0].type, 'dex_human_input_request');
  assert.equal(ui.controls.dexNewRoom.disabled, false);
  assert.equal(ui.controls.dexSaveRoom.disabled, false);
  assert.equal(ui.controls.dexClearChat.disabled, false);
  assert.equal(ui.controls.dexStopRelay.disabled, true);
  assert.equal(ui.controls.dexContinueRelay.disabled, false);
});

test('locking again invokes draft cleanup and a fresh controller always returns locked', () => {
  const ui = fixture();
  activate(ui);
  ui.toggle.click();
  ui.ctl.render(available);
  assert.equal(ui.relocks, 1);
  assert.deepEqual(ui.changes, ['active', 'locked']);
  assert.equal(ui.sent.at(-1).type, 'dex_human_input_disable');
  assert.equal(ui.ctl.isEnabled(), false);
  assert.equal(fixture().ctl.isEnabled(), false);
});

test('human unlock still respects runtime standby, reconnect, and busy-room safety', () => {
  const ui = fixture();
  activate(ui);
  ui.ctl.handleMessage({ type: 'dex_runtime_role', role: 'standby' });
  assert.equal(ui.controls.dexNewRoom.disabled, true);
  assert.equal(ui.panel.dataset.humanInput, 'denied');
  assert.match(ui.hint.textContent, /denied or revoked/);
  activate(ui);
  ui.ctl.render({ ...available, connected: false });
  assert.equal(ui.controls.dexSaveRoom.disabled, true);
  ui.ctl.connectionLost();
  assert.equal(ui.panel.dataset.humanInput, 'denied');
  activate(ui);
  ui.ctl.render({ ...available, busy: true });
  assert.equal(ui.controls.dexSaveRoom.disabled, true);
  assert.equal(ui.controls.dexStopRelay.disabled, false);
  assert.equal(ui.controls.dexContinueRelay.disabled, true);
});

test('a stopped room receipt permits editing while destructive history clearing stays fenced', () => {
  const ui = fixture();
  activate(ui);
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
  assert.match(mode, /humanInput\?\.authorization/);
  assert.match(mode, /providerAuthorization = msg\.authorization/);
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

test('bootstrap eligibility is limited to a pristine default room', () => {
  const room = {
    id: 'room-provisional', name: 'Dex Room 1',
    userName: 'User', members: [], messages: []
  };
  assert.equal(human.isBootstrapCandidate([room], room), true);
  assert.equal(human.isBootstrapCandidate([], room), false);
  assert.equal(human.isBootstrapCandidate([room, { ...room, id: 'other' }], room), false);
  assert.equal(human.isBootstrapCandidate([room], { ...room, name: 'Custom' }), false);
  assert.equal(human.isBootstrapCandidate([room], { ...room, userName: 'Other' }), false);
  assert.equal(human.isBootstrapCandidate([room], { ...room, members: [{}] }), false);
  assert.equal(human.isBootstrapCandidate([room], { ...room, messages: [{}] }), false);
});

test('out-of-order Human Input grants cannot revive a disabled controller', () => {
  const ui = fixture(); ui.ctl.render(available); ui.toggle.click();
  const pending = ui.sent.at(-1).requestId;
  ui.ctl.handleMessage({ type: 'dex_human_input_status', status: 'active', requestId: 'stale-enable', lease: lease() });
  assert.equal(ui.ctl.isEnabled(), false);
  ui.toggle.click();
  ui.ctl.handleMessage({ type: 'dex_human_input_status', status: 'active', requestId: pending, lease: lease() });
  assert.equal(ui.ctl.isEnabled(), false);
  activate(ui);
  assert.equal(ui.ctl.isEnabled(), true);
  ui.ctl.handleMessage({ type: 'dex_room_create_result', requestId: 'unsolicited', ok: true,
    roomId: 'room-other', lease: { ...lease(), roomId: 'room-other' } });
  assert.equal(ui.ctl.lease().roomId, 'room-one');
});

test('creation results must correlate to a pending server creation request', () => {
  const ui = fixture(); activate(ui);
  assert.equal(ui.ctl.createRoom(), true);
  const pending = ui.sent.at(-1).requestId;
  const creationLease = { ...lease(), scope: { type: 'create' }, roomId: null, operations: ['room:create'] };
  ui.ctl.handleMessage({ type: 'dex_human_input_status', status: 'creation-authorized',
    requestId: pending, lease: creationLease });
  const create = ui.sent.at(-1);
  assert.equal(create.type, 'dex_room_create');
  const next = { ...lease(), roomId: 'room-next' };
  ui.ctl.handleMessage({ type: 'dex_room_create_result', requestId: 'wrong', ok: true,
    roomId: 'room-next', lease: next });
  assert.equal(ui.ctl.lease().roomId, 'room-one');
  ui.ctl.handleMessage({ type: 'dex_room_create_result', requestId: create.requestId, ok: true,
    roomId: 'room-next', lease: next });
  assert.equal(ui.ctl.lease().roomId, 'room-next');
});
test('late disable and old denial/expiry statuses cannot revoke a newer active lease', () => {
  const ui = fixture();
  activate(ui);
  ui.toggle.click();
  const disabledRequestId = ui.sent.at(-1).requestId;
  activate(ui);
  assert.equal(ui.ctl.isEnabled(), true);
  for (const value of [
    { status: 'locked', requestId: disabledRequestId, code: 'DEX_HUMAN_INPUT_DISABLED' },
    { status: 'denied', requestId: 'old-request', code: 'DEX_HUMAN_LEASE_REVOKED' },
    { status: 'expired', requestId: 'old-expiry', code: 'DEX_HUMAN_LEASE_EXPIRED' }
  ]) {
    ui.ctl.handleMessage({ type: 'dex_human_input_status', ...value });
    assert.equal(ui.ctl.isEnabled(), true);
  }
  ui.ctl.handleMessage({ type: 'dex_human_input_status', status: 'locked',
    roomId: 'room-old', code: 'DEX_HUMAN_LEASE_SCOPE_CHANGED' });
  assert.equal(ui.ctl.isEnabled(), true);
  ui.ctl.handleMessage({ type: 'dex_human_input_status', status: 'locked',
    roomId: 'room-one', code: 'DEX_HUMAN_LEASE_SCOPE_CHANGED' });
  assert.equal(ui.ctl.isEnabled(), false);
  assert.equal(ui.ctl.status(), 'locked');
});