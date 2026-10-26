'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const traffic = require('../public/dex-middle-agent-traffic');

const member = (id, name, providerId = 'tlo-chat') => ({ id, name, relayEnabled: true,
  binding: { targetClassId: 'local-origin', targetId: `local:${id}`, providerId } });

function room() {
  return {
    id: 'room-visible', name: 'Visible Engineering',
    settings: { middleAgentMode: 'manual', middleAgentMemberId: 'tlo' },
    members: [member('tlo', 'TLO'), member('claude', 'Claude', 'claude')],
    engineeringIncidentReceipts: [{ key: 'job:failed', jobId: 'job-one', state: 'failed',
      classification: 'confirmed-command-or-test-failure', messageId: 'incident', middleAgentMemberId: 'tlo',
      dispatch: 'scheduled', createdAt: '2026-10-26T12:00:00Z' }],
    messages: [
      { id: 'incident', at: '2026-10-26T12:00:00Z', senderKind: 'system', senderName: 'Machine Spaces',
        text: '[ENGINEERING INCIDENT v1]', rawOutput: 'private terminal bytes',
        engineeringIncident: { jobId: 'job-one', requestId: 'req-one',
          state: 'failed', classification: 'confirmed-command-or-test-failure', outputId: 'output-one' } },
      { id: 'decision', at: '2026-10-26T12:00:01Z', senderKind: 'agent', senderId: 'tlo', senderName: 'TLO',
        text: 'Structured decision', engineeringProposal: { ok: true, schema: 'eveos.machine-spaces.engineering-proposal.v1',
          incidentJobId: 'job-one', summary: 'The assertion fails after the state transition.', confidence: .82,
          requestedEvidence: ['terminal output', 'exact failing assertion'],
          repair: { kind: 'source-patch', paths: ['src/state.js'], description: 'Preserve the pending transition.' },
          retryIntent: 'after-verified-repair' } },
      { id: 'receipt', at: '2026-10-26T12:00:02Z', senderKind: 'system', senderName: 'Dex', text: 'receipt',
        controlReceipt: { requestId: 'control-one', action: 'terminal_output', ok: true,
          roomId: 'room-visible', executorMemberId: 'tlo', originMessageId: 'decision' } },
      { id: 'worker-proposal', at: '2026-10-26T12:00:02Z', senderKind: 'agent', senderId: 'claude',
        senderName: 'Claude', text: 'Worker-only proposal', engineeringProposal: { ok: true,
          summary: 'This is not middle-agent traffic.', repair: { kind: 'source-patch' } } }
    ],
    localToolResults: [{ requestId: 'control-one', memberId: 'tlo', turnRequestId: 'turn-one',
      targetId: 'local:tlo', state: 'submitted-not-read', at: '2026-10-26T12:00:03Z' }]
  };
}

test('middle-agent selection is provider-neutral, explicit and fail-closed when ambiguous', () => {
  const value = room();
  assert.equal(traffic.selectedMiddle(value).id, 'tlo');
  value.settings = { middleAgentMode: 'automatic', middleAgentMemberId: null };
  assert.equal(traffic.selectedMiddle(value), null);
  value.members[1].relayEnabled = false;
  assert.equal(traffic.selectedMiddle(value).id, 'tlo');
  value.settings.middleAgentMode = 'disabled';
  assert.equal(traffic.selectedMiddle(value), null);
});

test('traffic projection exposes public evidence, reasoning, decisions and receipts without raw terminal output', () => {
  const projected = traffic.projectRoom(room());
  assert.equal(projected.middle.name, 'TLO');
  assert.deepEqual(projected.events.map((entry) => entry.kind), ['receipt', 'receipt', 'decision', 'trigger']);
  assert.equal(projected.events.find((entry) => entry.kind === 'trigger').member, 'TLO');
  assert.equal(projected.events.find((entry) => entry.kind === 'receipt').member, 'TLO');
  const decision = projected.events.find((entry) => entry.kind === 'decision');
  assert.match(decision.summary, /assertion fails/);
  assert.deepEqual(decision.rows, [
    ['Evidence requested', 'terminal output · exact failing assertion'],
    ['Confidence', '82%'],
    ['Decision', 'source-patch'],
    ['Repair scope', 'src/state.js'],
    ['Next step', 'after-verified-repair']
  ]);
  assert.equal(JSON.stringify(projected).includes('private terminal bytes'), false);
});

test('Nexus loads the bounded collapsible traffic projection before the room renderer', () => {
  const root = path.resolve(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'dex-middle-agent-traffic.css'), 'utf8');
  assert.match(html, /id="dexMiddleAgentTraffic"[^>]*data-nexus-collapsible[^>]*open/);
  assert.ok(html.indexOf('/dex-middle-agent-traffic.js') < html.indexOf('/dex-room-view.js'));
  assert.match(css, /max-height:[^;]+55vh/);
  assert.match(css, /overflow: auto/);
});
