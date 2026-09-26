'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { looksReadyForInput } = require('../local-targets/terminal-reply-parser');
const { sendPrompt, TARGET_PREFIX } = require('../local-targets/antigravity-existing');
const dex = require('../public/dex-protocol');

test('historical empty prompt never authorizes dispatch over newer unsent text', () => {
  assert.equal(looksReadyForInput('Earlier\n>\n? for shortcuts\n> new unsent draft\n? for shortcuts'), false);
  assert.equal(looksReadyForInput('Earlier\n>\n? for shortcuts\nNew response still streaming'), false);
  assert.equal(looksReadyForInput('Earlier\n>\n? for shortcuts\n● Bash(npm test)'), false);
  assert.equal(looksReadyForInput('Earlier\n> new draft\n? for shortcuts'), false);
  assert.equal(looksReadyForInput('Earlier\n>\n? for shortcuts       Gemini 3.8 Flash · medium'), true);
});
test('latest empty prompt with a footer is ready, active generation is not', () => {
  assert.equal(looksReadyForInput('Final reply.\n>\n────────────────────────\n? for shortcuts       Gemini 3.8 Flash · high'), true);
  assert.equal(looksReadyForInput('Earlier\n>\n? for shortcuts\n> new draft\nesc to cancel'), false);
});
test('Windows helper stages typing before exactly one native Enter with real scan code', () => {
  const helper = fs.readFileSync(path.join(__dirname, '../scripts/win-console-bridge.ps1'), 'utf8');
  const send = helper.slice(helper.indexOf('public static int Send('), helper.indexOf('\n}', helper.indexOf('public static int Send(')));
  assert.ok(send.includes('foreach (char ch in text'));
  assert.ok(send.includes('Thread.Sleep(80)'));
  assert.ok(send.includes("KeyRecord('\\r', 0x0D, true, 0x1C)"));
  assert.ok(send.includes("KeyRecord('\\r', 0x0D, false, 0x1C)"));
  assert.equal(send.split('WriteConsoleInputW(input, enter').length - 1, 1, 'one Enter write only');
});
test('RETURN is an exact-turn receipt, not an Enter action or relay stop', () => {
  const id = 'dex-turn-9a8c763f-ec15-43b4-833d-da5aac447fb6';
  const parsed = dex.parseAgentReply('Done reviewing.\n[[DEX:RETURN:' + id + ']]');
  assert.equal(parsed.returnRequestId, id);
  assert.equal(parsed.done, false);
  assert.equal(dex.relayDisposition(parsed, 'Astro', false,
    { active: true, remaining: 1 }).action, 'continue');
});
test('failed or uncertain local dispatch never auto-replays input', async () => {
  const requests = [];
  await assert.rejects(sendPrompt({
    requestId: 'never-retry', text: 'please review',
    target: { id: TARGET_PREFIX + '4242', pid: 4242, providerId: 'local-antigravity-existing' },
    snapshotImpl: () => ({ ok: true, text: 'Earlier\n>\n? for shortcuts' }),
    sendImpl: (_pid, value) => { requests.push(value); return { ok: false, error: 'enter outcome unknown' }; },
    sleepImpl: async () => {}, nowImpl: Date.now
  }), /enter outcome unknown/);
  assert.equal(requests.length, 1);
});
