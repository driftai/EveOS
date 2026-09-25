'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const protocol = require('../public/dex-protocol');
const browser = require('../public/dex-provider-control');
const content = require('../extension/content/dex-provider-control');
const routing = require('../dex/provider-control-routing');
const revision = require('../extension/content/provider-adapter-revision');
const cli = require('../scripts/dexctl');
const names = ['arm_post_idle', 'post_idle_status', 'cancel_post_idle', 'report_post_idle'];

test('provider/extension/browser registries all recognize exact post-idle commands', () => {
  for (const name of names) {
    assert.equal(protocol.PROVIDER_CONTROL_ACTIONS.has(name), true, name);
    assert.equal(browser.ACTIONS.has(name), true, name);
    assert.equal(content.ACTIONS.has(name), true, name);
  }
  assert.deepEqual([...routing.MUTATING_ACTIONS].sort(), [...browser.MUTATING_ACTIONS].sort());
  assert.equal(revision.ADAPTER_REVISION, 38);
});
test('localhost owns authorization, global idleness and atomic one-shot dispatch', () => {
  const server = read('server.js');
  const router = read('dex/provider-control-routing.js');
  const scheduler = read('dex/server-scheduler.js');
  const helper = read('dex/post-idle-maintenance.js');
  const runtime = read('dex/server-post-idle.js');
  const ui = read('dex/server-ensure-ui.js');
  assert.match(server, /startPostIdleMaintenance/);
  assert.match(runtime, /createPostIdleMaintenance/);
  assert.match(ui, /ensure_dex_ui/);
  assert.match(runtime, /getState: \(\) => dexStateStore\.load\(\)/);
  assert.match(runtime, /getTarget: \(id\) => localTargets\.getLocalTarget\(id\)/);
  assert.match(server, /maintenanceBusy: \(\) => !!postIdleMaintenance\?\.leaseActive\(\)/);
  assert.match(router, /POST_IDLE_ACTIONS\.has\(action\)/);
  assert.match(router, /commitOriginReceipt\(origin, result, requestId\)/);
  assert.match(scheduler, /if \(maintenanceBusy\(\)\) return/);
  assert.match(helper, /job\.state = 'claimed'; save\(\)/);
  assert.match(helper, /job\.state = job\.deliveryAcceptedAt \? 'awaiting_report' : 'outcome_unknown'/);
  assert.match(helper, /readGit/);
  assert.match(helper, /readyRooms\(/);
});
test('existing Astro can return an authenticated report without another Dex turn', () => {
  const parsed = cli.commandFrom({ commandName: 'report-post-idle',
    positionals: ['post-idle-abc'], options: { result: 'success', doctorOk: 'true',
      globalIdle: 'true', adapterRevision: '38', newSession: 'fresh',
      summary: 'All checks green.' } });
  assert.equal(parsed.action, 'report_post_idle');
  assert.equal(parsed.jobId, 'post-idle-abc');
  assert.equal(parsed.doctorOk, true);
  assert.equal(parsed.adapterRevision, 38);
  assert.match(read('DEX-MODE.md'), /Durable post-idle maintenance handoff/);
  assert.match(read('dex/post-idle-maintenance.js'), /no acknowledgement loop/i);
});
