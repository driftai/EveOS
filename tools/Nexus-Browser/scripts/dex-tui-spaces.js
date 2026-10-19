'use strict';
// Bounded read-only Machine Spaces inventory: no create, attach, grant, run or
// approval actions are exposed through this terminal client.
const { askLine, safe } = require('./dex-tui');
const { createPeer } = require('./dex-tui-peer');
const { randomUUID } = require('node:crypto');
function showTargets(targets = []) {
  const lines = ['\n  MACHINE SPACES  /  MANAGED TARGETS'];
  if (!targets.length) lines.push('  No managed terminal targets currently running.');
  targets.slice(0, 24).forEach((target, i) => {
    lines.push(`  ${i + 1}  ${safe(target.label || target.title || target.id)} · ${safe(target.type || target.targetType || 'terminal')}`);
    lines.push(`     ${safe(target.id, 128)}`);
  });
  return lines.join('\n');
}
function showRoom(snapshot = {}) {
  const lines = [`\n  ${safe(snapshot.roomName || snapshot.roomId)}  /  MACHINE SPACES`];
  if (!snapshot.spaces?.length) lines.push('  No Machine Spaces attached to this room.');
  for (const space of (snapshot.spaces || []).slice(0, 12)) {
    lines.push(`\n  ${safe(space.name || space.id)} ${space.archived ? '[archived]' : ''}`);
    lines.push(`    ID: ${safe(space.id, 128)} · grant: ${space.grant?.enabled ? 'enabled' : 'none/disabled'}`);
    for (const resource of (space.resources || []).slice(0, 12))
      lines.push(`    ${resource.available ? 'ready' : 'offline'}  ${safe(resource.label || resource.id, 80)}`);
    const requests = (space.requests || []).slice(-5);
    if (requests.length) lines.push(`    Recent requests: ${requests.map(r => safe(r.state || r.lifecycle?.state || 'unknown', 24)).join(' · ')}`);
  }
  return lines.join('\n');
}
async function runSpaces({ input = process.stdin, output = process.stdout,
  id = () => `dex-terminal-${randomUUID()}`,
  tx = (...args) => require('./dex-room-terminal').transact(...args),
  makePayload = (...args) => require('./dex-room-terminal').payload(...args),
  createConnection = createPeer } = {}) {
  const say = text => output.write(`${text}\n`);
  let peer, rooms = [];
  try {
    peer = createConnection();
    await peer.start;
    for (;;) {
      const targets = await peer.request({ type: 'request_machine_targets' },
        msg => msg.type === 'machine_targets_update');
      const result = await tx(makePayload({ command: 'rooms', requestId: id() }));
      if (!result?.ok || !Array.isArray(result.rooms)) throw new Error('Dex room discovery unavailable.');
      rooms = result.rooms.filter(r => r?.machineSpaceId).slice(0, 24);
      say(showTargets(targets.targets));
      say('\n  ROOMS WITH MACHINE SPACES');
      if (!rooms.length) say('  No rooms have an active Machine Space.');
      rooms.forEach((room, index) => say(`  ${index + 1}  ${safe(room.roomName)}${room.busy ? ' · busy' : ''}`));
      say('  Select room # to inspect · /refresh · /home · /quit');
      const value = await askLine(input, output, 'spaces> ');
      if (value === null || value.trim() === '/quit') return { navigation: 'quit' };
      if (['/home', '/back'].includes(value.trim())) return { navigation: 'home' };
      if (value.trim() === '/refresh') continue;
      const index = /^\d+$/.test(value.trim()) ? Number(value.trim()) - 1 : -1;
      const room = rooms[index] || rooms.find(r => r.roomId === value.trim());
      if (!room) { say('  ! Select a listed room.'); continue; }
      const snapshot = await peer.request({ type: 'machine_room_snapshot', roomId: room.roomId },
        msg => msg.type === 'machine_room_snapshot' && msg.roomId === room.roomId);
      say(showRoom(snapshot));
      say('  Read-only inspection; no commands or grants executed.');
    }
  } catch (error) {
    say(`  ! Machine Spaces unavailable: ${safe(error.message, 320)}`);
    return { navigation: 'home' };
  } finally { peer?.close(); }
}
module.exports = { runSpaces, showRoom, showTargets };
