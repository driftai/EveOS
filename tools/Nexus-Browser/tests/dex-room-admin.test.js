const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../public/dex-room-admin.js');

function room() {
  return {
    id: 'room-1',
    name: 'Core Room',
    userName: 'Drift',
    settings: { autoRelay: true, maxTurns: 8, contextMessages: 8 },
    members: [
      { id: 'eve', name: 'Eve', relayEnabled: true, binding: { providerId: 'chatgpt' } },
      { id: 'wren', name: 'Wren', relayEnabled: true, binding: { providerId: 'muse' } }
    ]
  };
}

test('room admin can rename and configure an idle room', () => {
  const value = room();
  assert.equal(admin.renameRoom(value, { name: 'Research Room' }).ok, true);
  const configured = admin.configureRoom(value, {
    autoRelay: false, maxTurns: 999, contextMessages: 12, userName: 'Drift'
  });
  assert.equal(configured.ok, true);
  assert.equal(value.name, 'Research Room');
  assert.deepEqual(value.settings, { autoRelay: false, maxTurns: 500, contextMessages: 12, contextDefaultMessages: 12, budgetRevision: 1 });
});

test('room admin resolves participants by id or unique exact name', () => {
  const value = room();
  assert.equal(admin.resolveMember(value, 'wren').member.name, 'Wren');
  assert.equal(admin.resolveMember(value, 'Eve').member.id, 'eve');
  value.members.push({ id: 'eve-2', name: 'Eve', binding: {} });
  assert.match(admin.resolveMember(value, 'Eve').error, /ambiguous/);
});

test('room admin can rename, observe, and remove another participant', () => {
  const value = room();
  value.agentCheckpoints = { wren: { memberId: 'wren', memberName: 'Wren', note: 'continue later' } };
  assert.equal(admin.renameAgent(value, { member: 'wren', name: 'Scout' }).member.name, 'Scout');
  assert.equal(value.agentCheckpoints.wren.memberName, 'Scout');
  const observed = admin.setAgentRelay(value, { member: 'wren', enabled: false });
  assert.equal(observed.member.relayEnabled, false);
  const removed = admin.removeAgent(value, { member: 'wren' });
  assert.equal(removed.ok, true);
  assert.deepEqual(value.members.map((member) => member.id), ['eve']);
  assert.equal(value.agentCheckpoints.wren, undefined);
});

test('room admin refuses to orphan a room by removing its final participant', () => {
  const value = room();
  value.members = [value.members[0]];
  const result = admin.removeAgent(value, { member: 'eve' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEX_CONTROL_LAST_AGENT');
});

test('room settings reject malformed values rather than guessing', () => {
  const value = room();
  assert.equal(admin.configureRoom(value, { maxTurns: 'banana' }).code, 'DEX_CONTROL_BAD_SETTING');
  assert.equal(admin.setAgentRelay(value, { member: 'eve', enabled: 'false' }).code, 'DEX_CONTROL_BAD_SETTING');
});
