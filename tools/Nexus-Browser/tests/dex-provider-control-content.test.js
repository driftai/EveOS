const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const content = require('../extension/content/dex-provider-control.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'dex-provider-control.js'), 'utf8');

test('provider command parser accepts only known trailing JSON control markers', () => {
  const parsed = content.parseTrailingCommand('Ready.\n\n[[DEX:CMD {"action":"rooms"}]]');
  assert.equal(parsed.command.action, 'rooms');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"unknown"}]]'), null);
  assert.equal(content.parseTrailingCommand('[[DEX:CMD not-json]]'), null);
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"rooms"}]]\nmore prose'), null);
});

test('provider command parser ignores markers inside fenced examples', () => {
  const text = 'Example only:\n```\n[[DEX:CMD {"action":"rooms"}]]\n```';
  assert.equal(content.parseTrailingCommand(text), null);
});

test('provider command parser carries structured send data without rewriting it', () => {
  const parsed = content.parseTrailingCommand('[[DEX:CMD {"action":"send","text":"hello Astro","relay":true}]]');
  assert.deepEqual(parsed.command, { action: 'send', text: 'hello Astro', relay: true });
});

test('provider command extraction falls back to the latest raw assistant node', () => {
  const answerApi = {
    latestAssistantText: () => 'Projected answer without the control marker.',
    assistantNodes: () => [{ innerText: '[[DEX:CMD {"action":"rooms"}]]' }]
  };
  assert.equal(content.latestCandidateText(answerApi), '[[DEX:CMD {"action":"rooms"}]]');
});

test('provider command extraction scans split blocks in the latest assistant turn', () => {
  const turn = {};
  const makeNode = (text) => ({ innerText: text, closest: () => turn });
  const answerApi = {
    latestAssistantText: () => 'Projected answer without the control marker.',
    assistantNodes: () => [
      makeNode('Earlier prose.'),
      makeNode('[[DEX:CMD {"action":"send","text":"hi Astro","relay":true}]]'),
      makeNode('Copy\nRead aloud')
    ]
  };
  const candidate = content.latestCandidateText(answerApi);
  assert.equal(content.parseTrailingCommand(candidate).command.text, 'hi Astro');
});

test('provider command extraction never replays a marker from an older assistant turn', () => {
  const oldTurn = {};
  const newTurn = {};
  const node = (text, turn) => ({ innerText: text, closest: () => turn });
  const answerApi = {
    latestAssistantText: () => 'Newest reply has no command.',
    assistantNodes: () => [
      node('[[DEX:CMD {"action":"rooms"}]]', oldTurn),
      node('Newest reply has no command.', newTurn)
    ]
  };
  assert.equal(content.latestCandidateText(answerApi), 'Newest reply has no command.');
});

test('provider command watcher coalesces mutation storms instead of starving the sampler', () => {
  assert.match(source, /function schedule\(delay = 900\) \{\s*if \(timer !== null\) return;/);
  assert.match(source, /timer = setTimeout\(\(\) => \{\s*timer = null;\s*sample\(\);/);
  assert.doesNotMatch(source, /function schedule[\s\S]{0,160}clearTimeout\(timer\)/);
  assert.match(source, /attributeFilter: \['aria-busy'\]/);
});

test('provider command watcher never executes while generation is active', () => {
  assert.equal(content.commandReady(false, content.SETTLED_MS - 1), false);
  assert.equal(content.commandReady(false, content.SETTLED_MS), true);
  assert.equal(content.commandReady(true, content.SETTLED_MS), false);
  assert.equal(content.commandReady(true, 60000), false);
});

test('provider command watcher stabilizes the exact marker before runtime dispatch', () => {
  assert.match(source, /candidateFingerprint = fingerprint;\s*candidateSince = observedAt;\s*schedule\(malformed \? MALFORMED_SETTLED_MS : SETTLED_MS\);/);
  assert.match(source, /commandReady\(generationActive\(runtime\), stableMs\)/);
  assert.match(source, /chrome\.runtime\.sendMessage\(\{\s*type: 'dex_provider_command'/);
});

test('provider command parser accepts agent-admin actions for headed room control', () => {
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"onboard"}]]').command.action, 'onboard');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"checkpoint","note":"next step"}]]').command.action, 'checkpoint');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"read_checkpoint"}]]').command.action, 'read_checkpoint');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"rename_self","name":"Nova"}]]').command.action, 'rename_self');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"set_self_relay","enabled":false}]]').command.action, 'set_self_relay');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"targets"}]]').command.action, 'targets');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"clear_chat"}]]').command.action, 'clear_chat');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"delete_room","room":"Old Room"}]]').command.action, 'delete_room');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"create_room","name":"Eve + Muse"}]]').command.action, 'create_room');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"rename_room","room":"Eve + Muse","name":"Research"}]]').command.action, 'rename_room');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"configure_room","room":"Research","maxTurns":20}]]').command.action, 'configure_room');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"remove_agent","room":"Research","member":"agent-1"}]]').command.action, 'remove_agent');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"stop_relay","room":"Research"}]]').command.action, 'stop_relay');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"continue_relay","room":"Research","turns":4}]]').command.action, 'continue_relay');
  const handoff = content.parseTrailingCommand('[[DEX:CMD {"action":"handoff_room","room":"Eve + Muse","text":"continue stress test","turns":8}]]');
  assert.equal(handoff.command.action, 'handoff_room');
  assert.equal(handoff.command.room, 'Eve + Muse');
  const add = content.parseTrailingCommand('[[DEX:CMD {"action":"add_agent","room":"Eve + Muse","targetClassId":"online-origin","targetId":30,"name":"Muse"}]]');
  assert.equal(add.command.action, 'add_agent');
  assert.equal(add.command.targetId, 30);
  const spawn = content.parseTrailingCommand('[[DEX:CMD {"action":"spawn_agent","room":"Eve + Muse","providerId":"muse","name":"Researcher"}]]');
  assert.equal(spawn.command.action, 'spawn_agent');
  assert.equal(spawn.command.providerId, 'muse');
  const despawn = content.parseTrailingCommand('[[DEX:CMD {"action":"despawn_agent","room":"Eve + Muse","member":"Researcher"}]]');
  assert.equal(despawn.command.action, 'despawn_agent');
});



test('provider command parser tolerates known assistant action-bar labels after the marker', () => {
  const parsed = content.parseTrailingCommand([
    'Ready.',
    '[[DEX:CMD {"action":"rooms"}]]',
    'Copy',
    'Good response',
    'Bad response',
    'Read aloud',
    'Share'
  ].join('\n'));
  assert.equal(parsed.command.action, 'rooms');
});

test('provider command parser still rejects arbitrary prose after a command marker', () => {
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"rooms"}]]\nthis is not UI chrome'), null);
  assert.equal(content.ignorableUiSuffix('Copy\nShare'), true);
  assert.equal(content.ignorableUiSuffix('Copy\nrun this command'), false);
});

test('DIL response blocks share the exact assistant turn when trailing control is split by UI chrome', () => {
  const answer = require('../extension/content/chatgpt-answer.js');
  assert.equal(content.DIL_TURN_SELECTOR, answer.DIL_ASSISTANT_SELECTOR);
  const turn = {};
  const node = innerText => ({
    innerText,
    closest(selector) { return selector.includes('DilResponseRoot') ? turn : null; }
  });
  const blocks = [
    node('[[DEX:CMD {"action":"targets","room":"room-eve-astro"}]]'),
    node('Copy')
  ];
  assert.equal(content.assistantTurn(blocks[0]), turn);
  const candidate = content.latestCandidateText({
    latestAssistantText: () => 'Copy',
    assistantNodes: () => blocks
  });
  assert.equal(content.parseTrailingCommand(candidate)?.command?.action, 'targets');
  const differentTurn = {};
  const latest = {
    innerText: 'Newest assistant reply without a command',
    closest(selector) { return selector.includes('DilResponseRoot') ? differentTurn : null; }
  };
  const stale = content.latestCandidateText({
    latestAssistantText: () => 'Newest assistant reply without a command',
    assistantNodes: () => [...blocks, latest]
  });
  assert.equal(content.parseTrailingCommand(stale), null, 'never replay an older DIL reply');
});

test('assistant message identity survives DIL block reflow and separates different turns', () => {
  const first = { getAttribute(name) { return name === 'data-chatgpt-selection-message-id' ? 'turn-1' : null; } };
  const second = { getAttribute(name) { return name === 'data-chatgpt-selection-message-id' ? 'turn-2' : null; } };
  const api = (turn, count) => ({
    assistantNodes: () => Array.from({ length: count }, () => ({ closest: () => turn }))
  });
  const parsed = content.parseTrailingCommand('[[DEX:CMD {"action":"status"}]]');
  const original = content.commandIdentity(api(first, 2), parsed);
  assert.equal(content.commandIdentity(api(first, 4), parsed), original);
  assert.notEqual(content.commandIdentity(api(second, 2), parsed), original);
  const legacy = {};
  const fallback = content.commandIdentity(api(legacy, 1), parsed);
  assert.equal(content.commandIdentity(api(legacy, 3), parsed), fallback);
  assert.notEqual(fallback, original);
});

test('watcher claims the entire turn before handing a command to background', () => {
  assert.match(source, /rememberDispatch\(turnKey, observedAt\);[\s\S]{0,160}chrome\.runtime\.sendMessage/);
  assert.match(source, /clientActionId: turnKey/);
});

test('watcher diagnostics expose only phases and counts, not conversation text', () => {
  const d = content.diagnostics();
  assert.equal(typeof d.samples, 'number');
  assert.equal(typeof d.phase, 'string');
  assert.equal(typeof d.assistantNodes, 'number');
  assert.equal(Object.hasOwn(d, 'text'), false);
  d.phase = 'mutated copy';
  assert.notEqual(content.diagnostics().phase, 'mutated copy');
});

test('valid command suppression waits for explicit localhost ownership', () => {
  const bridge = fs.readFileSync(path.join(root, 'extension/dex-provider-control-bridge.js'), 'utf8');
  const routing = fs.readFileSync(path.join(root, 'dex/provider-control-routing.js'), 'utf8');
  assert.match(source, /awaiting-localhost-admission/);
  assert.match(source, /ack\?\.ok === true && ack\?\.accepted === true/);
  assert.match(source, /delivery-outcome-uncertain/);
  assert.match(bridge, /provider_control_received/);
  assert.match(bridge, /DEX_CONTROL_ADMISSION_TIMEOUT/);
  assert.match(bridge, /sendResponse\(result/);
  assert.match(routing, /type: 'provider_control_received'/);
});
