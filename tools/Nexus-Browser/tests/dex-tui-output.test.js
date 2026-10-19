'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createPromptOutput } = require('../scripts/dex-tui-output');
const { runApp } = require('../scripts/dex-tui');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition() && Date.now() < deadline) await wait(5);
  assert.ok(condition(), 'input state was not reached');
}
test('writer redraws only when input is active and TTY, without fabricating input', () => {
  const output = new PassThrough(), chunks = [];
  output.on('data', chunk => chunks.push(String(chunk)));
  const view = createPromptOutput(output);
  let prompts = 0;
  const rl = { prompt(preserve) { assert.equal(preserve, true); prompts++; } };
  view.attach(rl);
  view.write('safe async reply');
  assert.equal(prompts, 0);
  output.isTTY = true;
  output.columns = 80;
  view.write('another reply');
  assert.equal(prompts, 1);
  view.detach(rl);
  view.write('final');
  assert.equal(prompts, 1);
  assert.match(chunks.join(''), /safe async reply/);
});
test('explicit /name overrides configured Dex room input identity but never sends', async () => {
  const input = new PassThrough(), output = new PassThrough(); let value = '';
  output.on('data', chunk => { value += String(chunk); });
  const calls = [];
  const task = runApp({ input, output, id: () => 'tui-test-xyz',
    makePayload: p => p,
    tx: async p => { calls.push(p.command); return { ok: true, rooms: [
      { roomId: 'room-example123', userName: 'Local operator', roomName: 'Example' }
    ] }; },
    runRoom: async (_p, options) => { assert.equal(options.displayName, 'drift'); return { navigation: 'home' }; }
  });
  await until(() => value.includes('nexus> ')); input.write('/name drift\n');
  await until(() => value.includes('Input identity set to drift')); input.write('1\n');
  await until(() => value.includes('ROOMS')); input.write('1\n');
  await until(() => value.includes('Connecting to Example')); input.write('/quit\n');
  await task;
  assert.deepEqual(calls, ['rooms']);
});

test('Base hides only the exact terminal DONE sentinel at the reply end', () => {
  const { cleanBaseReply } = require('../scripts/dex-tui-base');
  assert.equal(cleanBaseReply('Hello there! 🌱 [[DEX:DONE]]'), 'Hello there! 🌱');
  assert.equal(cleanBaseReply('[[DEX:DONE]] is a quoted phrase'), '[[DEX:DONE]] is a quoted phrase');
});
