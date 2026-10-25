'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const capability = require('../dex/agent-capability-context');
const protocol = require('../public/dex-protocol');
const content = require('../extension/content/dex-provider-control');
const publicControl = require('../public/dex-provider-control');
const server = require('../dex/server-provider-control');

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

test('capability document revisions and digests use cross-platform newline semantics', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-v072-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'config', 'agents', 'capabilities');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'registry.json'), JSON.stringify({
    schema: 'eveos.agent-capability-registry.v1', maxSelected: 1,
    maxContextChars: 5000,
    packs: [{ id: 'newline-proof', title: 'Line endings',
      path: 'config/agents/capabilities/sample.md', patterns: ['proof'] }]
  }));
  const sample = path.join(folder, 'sample.md');
  const unix = '# Proof\nLine two\n';
  fs.writeFileSync(sample, unix.replace(/\n/g, '\r\n'));
  const registry = capability.createRegistry({ root });
  const before = registry.resolve('[[EVEOS:CAPABILITIES newline-proof]]');
  assert.equal(before.packs[0].text, unix.trim());
  assert.equal(before.packs[0].revision, sha(unix).slice(0, 24));
  assert.equal(before.packs[0].sha256, sha(unix.trim()));
  fs.writeFileSync(sample, unix);
  const after = registry.resolve('[[EVEOS:CAPABILITIES newline-proof]]');
  assert.deepEqual(registry.publicContext(before), registry.publicContext(after));
});

test('Navigator commands remain read-only and server-routed across all Dex catalogs', () => {
  for (const action of ['nav_status', 'nav_search']) {
    assert.ok(protocol.PROVIDER_CONTROL_ACTIONS.has(action), `${action}: relay parser`);
    assert.ok(content.ACTIONS.has(action), `${action}: provider extension`);
    assert.ok(publicControl.ACTIONS.has(action), `${action}: public command catalog`);
    assert.ok(server.SERVER_ROUTED_ACTIONS.has(action), `${action}: Machine Spaces owns execution`);
    assert.ok(!publicControl.MUTATING_ACTIONS.has(action), `${action}: not a mutation`);
    assert.ok(!server.ACTIONS.has(action), `${action}: not Dex room-admin execution`);
  }
  assert.deepEqual([...protocol.PROVIDER_CONTROL_ACTIONS].sort(), [...content.ACTIONS].sort());
  assert.deepEqual([...protocol.PROVIDER_CONTROL_ACTIONS].sort(), [...publicControl.ACTIONS].sort());
});
