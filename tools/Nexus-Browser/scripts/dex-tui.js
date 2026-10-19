#!/usr/bin/env node
'use strict';
// Room picker for the existing Dex terminal operator. Selection is read-only;
// only the established room chat client can submit a user-origin message.
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

const ROOM_ID = /^room-[A-Za-z0-9_-]{6,125}$/;
const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 80);
const nextId = () => `dex-terminal-${randomUUID()}`;

function chooseRoom(choice, rooms) {
  const entry = String(choice || '').trim();
  if (/^[1-9]\d*$/.test(entry)) return rooms[Number(entry) - 1] || null;
  return rooms.find(room => room.roomId === entry) || null;
}
function formatRooms(rooms) {
  if (!rooms.length) return 'No available Dex rooms. Use /refresh to check again.';
  const lines = ['Available Dex rooms:'];
  rooms.forEach((room, index) => {
    const states = [room.busy ? 'busy' : 'idle'];
    if (room.recoveryPending) states.push('recovery pending');
    if (room.tloMemberId) states.push('TLO');
    if (room.machineSpaceId) states.push('Machine Space');
    lines.push(`${index + 1}. ${safe(room.roomName) || safe(room.roomId)} [${states.join(', ')}]`);
    lines.push(`   ${room.roomId}`);
  });
  return lines.join('\n');
}
async function runApp({ input = process.stdin, output = process.stdout,
  tx = (...args) => require('./dex-room-terminal').transact(...args),
  makePayload = (...args) => require('./dex-room-terminal').payload(...args),
  id = nextId, runRoom = (...args) => require('./dex-room-tui').runTui(...args) } = {}) {
  let rooms = [];
  const say = message => output.write(`${message}\n`);
  async function refresh() {
    // Discovery never submits a room message or changes dispatch ownership.
    const result = await tx(makePayload({ command: 'rooms', requestId: id() }));
    if (!result?.ok || !Array.isArray(result.rooms)) {
      rooms = []; // An old picker snapshot must not be used after a failed refresh.
      say(`! ${safe(result?.code || 'DEX_TUI_ROOMS_UNAVAILABLE')}: ${safe(result?.message || 'Room discovery failed.')}`);
      return;
    }
    rooms = result.rooms.filter(room => ROOM_ID.test(room?.roomId || '')).slice(0, 32);
    say(formatRooms(rooms));
  }
  say('EveOS Dex TUI · choose a room number or exact room ID');
  say('Commands: /refresh /help /quit');
  try { await refresh(); }
  catch (error) { rooms = []; say(`! Room discovery unavailable: ${safe(error?.message || error)}`); }
  const rl = readline.createInterface({ input, output, terminal: !!output.isTTY, prompt: 'dex-tui> ' });
  try {
    rl.prompt();
    for await (const raw of rl) {
      const choice = raw.trim();
      if (choice === '/quit' || choice === '/exit') return { ok: true, quit: true };
      if (choice === '/help') say('Choose a displayed number or exact room ID. /refresh reloads rooms. /quit exits.');
      else if (choice === '/refresh') {
        try { await refresh(); }
        catch (error) { rooms = []; say(`! Room discovery unavailable: ${safe(error?.message || error)}`); }
      } else if (choice) {
        const selected = chooseRoom(choice, rooms);
        if (!selected) say('No matching listed room. Use /refresh or select an exact displayed room ID.');
        else {
          // Stop consuming stdin before transferring ownership to the proven
          // single-room TUI. No messages are sent as part of room selection.
          rl.close();
          say(`Opening ${safe(selected.roomName) || selected.roomId} (${selected.roomId})`);
          await runRoom({ room: selected.roomId }, { tx, payload: makePayload, id, input, output });
          return { ok: true, roomId: selected.roomId };
        }
      }
      rl.prompt();
    }
    return { ok: true, quit: true };
  } finally { rl.close(); }
}
if (require.main === module) runApp().catch(error => {
  console.error('DEX_TUI_STOP', error.code || '', error.message || error);
  process.exitCode = 2;
});
module.exports = { runApp, formatRooms, chooseRoom };
