'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAgentLiveContext } = require('../dex/agent-live-context');
test('Dex agent contract identifies Codex Governor separately from TLO local work', () => {
  const contract = buildAgentLiveContext({ room: { id: 'room-exact', name: 'Engineering' },
    member: { id: 'tlo-exact', name: 'TLO', binding: { transport: 'search-monitor-workspace' } } });
  assert.match(contract, /Codex-backed Governor/);
  assert.match(contract, /TLO local chat, testing and approved recovery do not consume Codex quota/);
  assert.match(contract, /ready TLO is not evidence of authorized Git publication/);
});
test('TLO guide preserves explicit worker, quota and authority separation', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const content = fs.readFileSync(path.join(root, 'config/agents/tlo/NEXUS.md'), 'utf8');
  assert.match(content, /Do not infer the executor is Nova\/Codex/);
  assert.match(content, /governor_prepare.*Codex-backed/s);
  assert.match(content, /Machine Spaces grants and Human Input approval remain mandatory/);
});
