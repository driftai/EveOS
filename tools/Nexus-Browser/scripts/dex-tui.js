#!/usr/bin/env node
'use strict';
// Terminal-native navigation. Each child view owns stdin exclusively until it
// returns. No room or target is dispatched while navigating.
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { displayName } = require('./dex-tui-identity');
const { createPromptOutput } = require('./dex-tui-output');
const ROOM_ID = /^room-[A-Za-z0-9_-]{6,125}$/;
const safe = (value, limit = 80) => String(value ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, limit);
const nextId = () => `dex-terminal-${randomUUID()}`;
function chooseRoom(choice, rooms) {
  const entry = String(choice || '').trim();
  if (/^[1-9]\d*$/.test(entry)) return rooms[Number(entry) - 1] || null;
  return rooms.find(room => room.roomId === entry) || null;
}
function formatRooms(rooms) {
  if (!rooms.length) return '  No rooms found. Use /refresh to retry.';
  const lines = ['  ROOMS'];
  rooms.forEach((room, index) => {
    const states = [room.busy ? 'busy' : 'idle'];
    if (room.recoveryPending) states.push('recovery');
    if (room.tloMemberId) states.push('TLO');
    if (room.machineSpaceId) states.push('space');
    lines.push(`  ${String(index + 1).padStart(2)}  ${safe(room.roomName) || safe(room.roomId)}  [${states.join(' · ')}]`);
  });
  return lines.join('\n');
}
function home() {
  return '\n  EVEOS  /  NEXUS TERMINAL\n'
    + '  ─────────────────────────────────────\n'
    + '  1  Dex rooms           Chat and receipts\n'
    + '  2  Base Mode           Select a local target\n'
    + '  3  Machine Spaces      Read-only inventory\n'
    + '  ─────────────────────────────────────\n'
    + '  /name NAME set your label · /quit exit  ·  /help commands\n';
}
function askLine(input, output, prompt, promptView = null) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output, terminal: !!output.isTTY });
    let done = false;
    const finish = value => { if (done) return; done = true; promptView?.detach(rl); rl.close(); resolve(value); };
    rl.once('line', finish);
    rl.once('close', () => finish(null));
    rl.setPrompt(prompt);
    promptView?.attach(rl);
    rl.prompt();
  });
}
async function runApp({ input = process.stdin, output = process.stdout,
  tx = (...args) => require('./dex-room-terminal').transact(...args),
  makePayload = (...args) => require('./dex-room-terminal').payload(...args),
  id = nextId,
  runRoom = (...args) => require('./dex-room-tui').runTui(...args),
  runBase = (...args) => require('./dex-tui-base').runBase(...args),
  runSpaces = (...args) => require('./dex-tui-spaces').runSpaces(...args)
} = {}) {
  const say = message => output.write(`${message}\n`);
  let place = 'home';
  let rooms = [];
  let preferredName = displayName(process.env.NEXUS_TUI_DISPLAY_NAME || 'User');
  let nameExplicit = !!process.env.NEXUS_TUI_DISPLAY_NAME;
  async function refresh() {
    try {
      const result = await tx(makePayload({ command: 'rooms', requestId: id() }));
      if (!result?.ok || !Array.isArray(result.rooms)) throw Object.assign(
        new Error(result?.message || 'Room discovery failed'), { code: result?.code || 'ROOMS_UNAVAILABLE' });
      rooms = result.rooms.filter(room => ROOM_ID.test(room?.roomId || '')).slice(0, 32);
      return true;
    } catch (error) {
      rooms = []; // never select from a stale discovery snapshot
      say(`  ! ${safe(error.code || 'ROOMS_UNAVAILABLE')}: ${safe(error.message)}`);
      return false;
    }
  }
  for (;;) {
    if (place === 'home') {
      say(home());
      const value = await askLine(input, output, 'nexus> ');
      if (value === null || ['/quit', '/exit', 'q'].includes(value.trim())) return { ok: true, quit: true };
      if (value.trim().startsWith('/name ')) {
        preferredName = displayName(value.trim().slice(6));
        nameExplicit = true;
        say(`  Input identity set to ${preferredName} (this terminal session only).`);
        continue;
      }
      if (['1', '/dex', '/rooms'].includes(value.trim())) { place = 'rooms'; await refresh(); continue; }
      if (['2', '/base'].includes(value.trim())) { place = 'base'; continue; }
      if (['3', '/spaces', '/machine'].includes(value.trim())) { place = 'spaces'; continue; }
      say('  Commands: 1 Dex rooms · 2 Base Mode · 3 Machine Spaces · /quit');
    } else if (place === 'rooms') {
      say(`\n${formatRooms(rooms)}\n  /refresh reload · /home main menu · /quit exit`);
      const value = await askLine(input, output, 'rooms> ');
      if (value === null || value.trim() === '/quit') return { ok: true, quit: true };
      if (['/home', '/back'].includes(value.trim())) { place = 'home'; continue; }
      if (value.trim() === '/refresh') { await refresh(); continue; }
      const selected = chooseRoom(value, rooms);
      if (!selected) { say('  ! Not a listed room. Use a number or exact room ID.'); continue; }
      say(`\n  Connecting to ${safe(selected.roomName)}…`);
      const roomUser = displayName(nameExplicit ? preferredName : (selected.userName || preferredName));
      if (!nameExplicit && selected.userName && preferredName === 'User') preferredName = roomUser;
      const result = await runRoom({ room: selected.roomId }, { tx, payload: makePayload, id, input, output, displayName: roomUser });
      if (result?.navigation === 'quit') return { ok: true, quit: true };
      if (result?.navigation === 'home') place = 'home';
      else { place = 'rooms'; await refresh(); }
    } else if (place === 'base') {
      const result = await runBase({ input, output, id, displayName: preferredName });
      if (result?.navigation === 'quit') return { ok: true, quit: true };
      place = result?.navigation === 'rooms' ? 'rooms' : 'home';
      if (place === 'rooms') await refresh();
    } else if (place === 'spaces') {
      const result = await runSpaces({ input, output, id, tx, makePayload });
      if (result?.navigation === 'quit') return { ok: true, quit: true };
      place = result?.navigation === 'rooms' ? 'rooms' : 'home';
      if (place === 'rooms') await refresh();
    }
  }
}
if (require.main === module) runApp().catch(error => {
  console.error('DEX_TUI_STOP', error.code || '', error.message || error);
  process.exitCode = 2;
});
module.exports = { runApp, formatRooms, chooseRoom, home, askLine, safe };
