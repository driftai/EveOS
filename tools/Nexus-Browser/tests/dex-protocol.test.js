const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/dex-protocol.js');
const providerContent = require('../extension/content/dex-provider-control.js');
const providerControl = require('../public/dex-provider-control.js');

function room() {
  return {
    id: 'room-1',
    name: 'Core Room',
    settings: { contextMessages: 8 },
    members: [
      { id: 'eve', name: 'Eve', binding: { targetClassId: 'online-origin', providerName: 'ChatGPT' } },
      { id: 'astro', name: 'Astro', binding: { targetClassId: 'local-origin', providerName: 'Antigravity CLI' } }
    ],
    messages: []
  };
}

test('relay turn budget has one shared upper bound', () => {
  assert.equal(protocol.MAX_RELAY_TURNS, 500);
  assert.equal(protocol.clampInt(999, 1, protocol.MAX_RELAY_TURNS, 8), 500);
});

test('Dex wraps user and agent identities exactly once', () => {
  assert.equal(
    protocol.messageWrapper({ senderKind: 'user', senderName: 'Drift', text: 'hello' }),
    'hello\n\n- From User (Drift)'
  );
  assert.equal(
    protocol.messageWrapper({ senderKind: 'agent', senderName: 'Eve', text: 'hi' }),
    'hi\n\n- From Eve'
  );
});

test('Dex recognizes only known trailing relay control tokens', () => {
  assert.deepEqual(protocol.parseAgentReply('Finished. [[DEX:DONE]]'), {
    text: 'Finished.', done: true, needsUser: false, note: false
  });
  assert.deepEqual(protocol.parseAgentReply('Need a choice. [[DEX:USER]]'), {
    text: 'Need a choice.', done: false, needsUser: true, note: false
  });
  assert.deepEqual(protocol.parseAgentReply('Build passed. [[DEX:NOTE]]'), {
    text: 'Build passed.', done: false, needsUser: false, note: true
  });
  assert.deepEqual(protocol.parseAgentReply('The token [[DEX:NOTE]] means no reply, but keep talking.'), {
    text: 'The token [[DEX:NOTE]] means no reply, but keep talking.', done: false, needsUser: false, note: false
  });
  assert.deepEqual(protocol.parseAgentReply('Unknown marker. [[DEX:FUTURE_EVENT]]'), {
    text: 'Unknown marker. [[DEX:FUTURE_EVENT]]', done: false, needsUser: false, note: false
  });
});

test('relay provider-control vocabulary matches the executable provider command surfaces', () => {
  assert.deepEqual([...protocol.PROVIDER_CONTROL_ACTIONS].sort(), [...providerContent.ACTIONS].sort());
  assert.deepEqual([...protocol.PROVIDER_CONTROL_ACTIONS].sort(), [...providerControl.ACTIONS].sort());
});

test('extension reload is recognized as provider control and stops the relay before the localhost safety gate', () => {
  const value = 'Reload only while all rooms are idle. [[DEX:CMD {"action":"reload_extension","room":"room-1"}]]';
  const parsed = protocol.parseAgentReply(value);
  assert.equal(parsed.text, 'Reload only while all rooms are idle.');
  assert.equal(parsed.providerCommand, 'reload_extension');
  assert.deepEqual(parsed.providerControlCommand, { action: 'reload_extension', room: 'room-1' });
  assert.deepEqual(protocol.relayDisposition(parsed, 'Eve', false, { active: true, remaining: 2 }),
    { action: 'stop', kind: 'control', reason: 'Eve requested Dex provider control' });
});

test('unknown trailing Dex commands remain ordinary prose and do not pause the relay', () => {
  const text = 'Typo should stay visible. [[DEX:CMD {"action":"spawn_agnet","room":"Worker Room"}]]';
  const parsed = protocol.parseAgentReply(text);
  assert.equal(parsed.text, text);
  assert.equal(parsed.providerCommand, undefined);
  assert.deepEqual(
    protocol.relayDisposition(parsed, 'Eve', false, { active: true, remaining: 5 }),
    { action: 'continue', kind: 'reply', reason: null }
  );
});

test('cross-room handoff marker is stripped from transcript text and stops the current relay', () => {
  const parsed = protocol.parseAgentReply('Moving the stress run. [[DEX:CMD {"action":"handoff_room","room":"Stress Room","text":"Continue with Wren.","turns":8}]]');
  assert.equal(parsed.text, 'Moving the stress run.');
  assert.equal(parsed.handoff, true);
  assert.deepEqual(
    protocol.relayDisposition(parsed, 'Eve Stress', false, { active: true, remaining: 20 }),
    { action: 'stop', kind: 'handoff', reason: 'Eve Stress requested a cross-room handoff' }
  );
});

test('generic provider-control command is stripped and pauses the relay before orchestration', () => {
  const parsed = protocol.parseAgentReply('I need a worker. [[DEX:CMD {"action":"spawn_agent","room":"Worker Room","providerId":"muse","name":"Researcher"}]]');
  assert.equal(parsed.text, 'I need a worker.');
  assert.equal(parsed.providerCommand, 'spawn_agent');
  assert.deepEqual(parsed.providerControlCommand, { action: 'spawn_agent', room: 'Worker Room', providerId: 'muse', name: 'Researcher' });
  assert.equal(parsed.handoff, undefined);
  assert.deepEqual(
    protocol.relayDisposition(parsed, 'Eve', false, { active: true, remaining: 20 }),
    { action: 'stop', kind: 'control', reason: 'Eve requested Dex provider control' }
  );
});

test('relay prompt advertises self-discoverable provider control without embedding the whole command catalog', () => {
  const value = room();
  const prompt = protocol.buildRelayPrompt({
    room: value,
    recipient: value.members[0],
    sourceMessage: { id: 'm-control', senderKind: 'user', senderName: 'Drift', text: 'Use workers if useful.' },
    requestId: 'dex-control-turn'
  });
  assert.match(prompt, /"action":"onboard"/);
  assert.match(prompt, /trailing provider-control command pauses this relay/);
  assert.doesNotMatch(prompt, /"action":"spawn_agent"/);
});


test('two-agent acknowledgement returns to requester before DONE closes the room', () => {
  const value = room();
  const astroAck = protocol.parseAgentReply('ASTRO_LINK_ACK. Confirmed receipt in my existing terminal.');
  assert.deepEqual(protocol.relayDisposition(astroAck, 'Astro', false, { active: true, remaining: 1 }),
    { action: 'continue', kind: 'reply', reason: null });
  assert.equal(protocol.nextMemberIndex(value, {
    senderKind: 'agent', senderId: 'astro'
  }), 0, 'the no-marker acknowledgement goes back to Eve in this two-member room');

  const eveConfirmation = protocol.parseAgentReply('ACK received; live link verified. [[DEX:DONE]]');
  assert.deepEqual(protocol.relayDisposition(eveConfirmation, 'Eve', false, { active: true, remaining: 0 }),
    { action: 'stop', kind: 'done', reason: 'Eve marked the room complete' });

  const prematureDone = protocol.parseAgentReply('ASTRO_LINK_ACK [[DEX:DONE]]');
  assert.equal(protocol.relayDisposition(prematureDone, 'Astro', false, { active: true, remaining: 1 }).action,
    'stop', 'DONE from the responder stops before the requester gets an agent turn');
});

test('relay disposition centralizes stop and continue semantics', () => {
  assert.deepEqual(
    protocol.relayDisposition({ note: true }, 'Astro', false, { active: true, remaining: 4 }),
    { action: 'stop', kind: 'note', reason: 'Astro posted a note' }
  );
  assert.deepEqual(
    protocol.relayDisposition({}, 'Eve', false, { active: true, remaining: 3 }),
    { action: 'continue', kind: 'reply', reason: null }
  );
  assert.deepEqual(
    protocol.relayDisposition({}, 'Eve', false, { active: false, remaining: 3, lastStopReason: 'Stopped by user' }),
    { action: 'stop', kind: 'stopped', reason: 'Stopped by user' }
  );
});

test('relay prompt carries explicit room, turn, recipient, participants and context metadata', () => {
  const value = room();
  value.messages.push(
    { id: 'm1', senderKind: 'user', senderName: 'Drift', text: 'Build the first pass.' },
    { id: 'm2', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'I will design it.' }
  );
  const prompt = protocol.buildRelayPrompt({
    room: value,
    recipient: value.members[1],
    sourceMessage: value.messages[1],
    requestId: 'dex-turn-1'
  });
  assert.match(prompt, /Room ID: room-1/);
  assert.match(prompt, /Turn ID: dex-turn-1/);
  assert.match(prompt, /Source Message ID: m2/);
  assert.match(prompt, /Recipient: Astro/);
  assert.doesNotMatch(prompt, /You are:/);
  assert.match(prompt, /- Eve \[Online-Origin \/ ChatGPT\]/);
  assert.match(prompt, /- Astro \[Local-Origin \/ Antigravity CLI\]/);
  assert.match(prompt, /- From User \(Drift\)/);
  assert.match(prompt, /- From Eve/);
  assert.match(prompt, /\[\[DEX:DONE\]\]/);
  assert.match(prompt, /responder must reply WITHOUT a control marker/);
  assert.match(prompt, /requester can then end its confirmation turn/);
  assert.match(prompt, /NEXT participating agent in room order/);
  assert.match(prompt, /\[\[DEX:USER\]\]/);
  assert.match(prompt, /\[\[DEX:NOTE\]\]/);
  assert.match(prompt, /Control markers are interpreted only when they trail the reply/);
  assert.match(prompt, /handoff_room/);
  assert.match(prompt, /Dex stops this room before starting the authorized target room/);
});

test('relay prompt accepts the runtime member field as its recipient', () => {
  const value = room();
  const sourceMessage = { id: 'm3', senderKind: 'user', senderName: 'Drift', text: 'Hello Astro.' };
  const prompt = protocol.buildRelayPrompt({
    room: value,
    member: value.members[1],
    sourceMessage,
    requestId: 'dex-runtime-turn'
  });
  assert.match(prompt, /Recipient: Astro/);
  assert.doesNotMatch(prompt, /Recipient: Agent/);
});

test('round robin starts with first member and advances after an agent message', () => {
  const value = room();
  assert.equal(protocol.nextMemberIndex(value, { senderKind: 'user', senderId: 'user' }), 0);
  assert.equal(protocol.nextMemberIndex(value, { senderKind: 'agent', senderId: 'eve' }), 1);
  assert.equal(protocol.nextMemberIndex(value, { senderKind: 'agent', senderId: 'astro' }), 0);
});

test('repeated reply guard catches the third matching agent response', () => {
  const messages = [
    { senderKind: 'agent', text: 'Same answer' },
    { senderKind: 'user', text: 'continue' },
    { senderKind: 'agent', text: ' same   answer ' }
  ];
  assert.equal(protocol.isRepeatedReply(messages, 'Same answer'), true);
  assert.equal(protocol.isRepeatedReply(messages, 'Different answer'), false);
});

test('bounded context limits history and very large message blocks', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    senderKind: index % 2 ? 'agent' : 'user',
    senderName: index % 2 ? 'Eve' : 'Drift',
    text: `message-${index}`
  }));
  const context = protocol.boundedContext(messages, 4);
  assert.equal(context.includes('message-7'), false);
  assert.equal(context.includes('message-8'), true);
  assert.equal(context.includes('message-11'), true);
});


test('round robin skips observer participants without removing them from the room', () => {
  const value = room();
  value.members.splice(1, 0, {
    id: 'observer',
    name: 'Observer',
    relayEnabled: false,
    binding: { targetClassId: 'local-origin', providerName: 'Antigravity CLI' }
  });
  assert.equal(protocol.nextMemberIndex(value, { senderKind: 'agent', senderId: 'eve' }), 2);
  assert.equal(protocol.nextMemberIndex(value, { senderKind: 'agent', senderId: 'astro' }), 0);
  const prompt = protocol.buildRelayPrompt({
    room: value,
    recipient: value.members[2],
    sourceMessage: { id: 'm-observer', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'continue' },
    requestId: 'dex-observer'
  });
  assert.match(prompt, /Observer \[Local-Origin \/ Antigravity CLI · observer\]/);
});

test('round robin reports no target when every room participant is observing', () => {
  const value = room();
  for (const member of value.members) member.relayEnabled = false;
  assert.equal(protocol.nextMemberIndex(value, { senderKind: 'user' }), -1);
});


test('relay prompt exposes runtime provider availability to other agents', () => {
  const value = room();
  const prompt = protocol.buildRelayPrompt({
    room: value,
    recipient: value.members[1],
    sourceMessage: { id: 'm-health', senderKind: 'user', senderName: 'Drift', text: 'continue' },
    requestId: 'dex-health',
    providerHealth: '- Eve [ChatGPT]: Quota reached · action: wait for provider quota reset · ~2h remaining'
  });
  assert.match(prompt, /Provider availability:/);
  assert.match(prompt, /Quota reached/);
  assert.match(prompt, /wait for provider quota reset/);
});
