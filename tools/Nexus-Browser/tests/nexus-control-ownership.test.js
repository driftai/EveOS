'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROL = fs.readFileSync(path.join(ROOT, 'server_modules', 'nexus_browser_control.py'), 'utf8');

test('Nexus control plane trusts only the verified supervisor-owned server listener when health is transiently missing', () => {
  assert.match(CONTROL, /def _owned_listener_pid\(supervisor_pid/);
  assert.match(CONTROL, /_process_parent_pid\(listener_pid\) == supervisor_pid/);
  assert.match(CONTROL, /root in command and "server\.js" in command/);
  assert.match(CONTROL, /running = health is not None or owned_listener is not None/);
  assert.match(CONTROL, /blocked = _port_open\(\) and not running/);
  assert.match(CONTROL, /health probe is recovering/);
});
