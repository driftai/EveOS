'use strict';
// Bounded, non-executing TLO proof-room bootstrap for trusted localhost scripts.
// Room/supervision authorities remain Dex + Machine Spaces. This module cannot
// create grants, invoke a model, execute shell commands, or authorize publication.
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const ROOM_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,47}$/;
const PROOF_KIND = 'eveos.dex-tlo-scripted-bootstrap.v1';
const DEFAULT_NAME = 'TLO Autonomy Proof';
const TLO = Object.freeze({ targetClassId: 'local-origin', targetId: 'local:tlo-chat:default',
  targetTypeId: 'provider-workspace', providerId: 'tlo-chat', providerName: 'TLO',
  title: 'TLO Chat', transport: 'search-monitor-workspace', sessionOrigin: 'shared-search-monitor-workspace' });
function fail(code, message) { return { ok: false, code, message }; }
function proofRoom(room) {
  return room?.terminalBootstrap?.schema === PROOF_KIND && room.terminalBootstrap.requestId;
}
function makeRoom({ name, requestId, idFactory, at, target }) {
  const roomId = `room-${idFactory()}`;
  const memberId = `agent-${idFactory()}`;
  const spaceId = `machine-space-${idFactory()}`;
  return {
    id: roomId, name, userName: 'Local operator', createdAt: at, updatedAt: at,
    members: [{ id: memberId, name: 'TLO', relayEnabled: true,
      binding: { ...TLO, capabilities: { chat: true, captureLatest: false } } }],
    messages: [], settings: { autoRelay: false, maxTurns: 1, contextMessages: 8 },
    relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
    machineSpaces: { spaces: [{ id: spaceId, name: 'TLO Proof Machine Space', archived: false,
      resourceIds: [target.id], requests: [], ledger: null, grant: null, fileGrants: [], createdAt: at }] },
    terminalBootstrap: { schema: PROOF_KIND, requestId, targetId: target.id,
      memberId, spaceId, createdAt: at, executionPermission: 'none' }
  };
}
function response(room, broker, idempotent) {
  const b = room.terminalBootstrap;
  const target = broker.target(b.targetId);
  const space = room.machineSpaces?.spaces?.find(s => s.id === b.spaceId && !s.archived);
  const member = room.members?.find(m => m.id === b.memberId);
  const ready = !!target && !!space && space.resourceIds?.includes(b.targetId)
    && member?.binding?.providerId === TLO.providerId
    && member?.binding?.targetId === TLO.targetId
    && member.relayEnabled !== false;
  return { ok: true, action: 'bootstrap', idempotent, roomId: room.id, roomName: room.name,
    tloMemberId: b.memberId, machineSpaceId: b.spaceId, targetId: b.targetId,
    ready, grantsEnabled: !!space?.grant?.enabled || (space?.fileGrants || []).some(g => g.enabled),
    modelInvocations: 0, executionAuthority: 'not-granted',
    note: ready ? 'Room and attached terminal ready; actual agent replies and actions remain unproven.'
      : 'Original target/room binding no longer live. No automatic recreation or replay.' };
}
function bootstrap({ requestId, roomName = DEFAULT_NAME, load, save, broadcastState = () => {},
  broker, repoRoot, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!ROOM_NAME.test(roomName)) return fail('DEX_BOOTSTRAP_BAD_NAME', 'Use a short alphanumeric proof-room name.');
  if (typeof load !== 'function' || typeof save !== 'function' || !broker?.createSession || !broker?.target)
    return fail('DEX_BOOTSTRAP_UNAVAILABLE', 'The existing durable Dex owner or Machine Spaces broker is unavailable.');
  const snapshot = load() || { version: 1, rooms: [], activeRoomId: null, savedAt: now() };
  if (!Array.isArray(snapshot.rooms)) return fail('DEX_BOOTSTRAP_BAD_STATE', 'Room state unavailable.');
  const prior = snapshot.rooms.filter(room => room?.terminalBootstrap?.requestId === requestId);
  if (prior.length) {
    if (prior.length !== 1 || !proofRoom(prior[0]) || prior[0].name !== roomName)
      return fail('DEX_BOOTSTRAP_REQUEST_CONFLICT', 'The request ID already has a different bootstrap identity.');
    return response(prior[0], broker, true);
  }
  if (snapshot.rooms.length >= 32) return fail('DEX_BOOTSTRAP_ROOM_LIMIT', 'At most 32 rooms may exist.');
  // Never reuse a prior bootstrap target or mutate an unrelated room.
  if (!repoRoot || !path.isAbsolute(repoRoot)) return fail('DEX_BOOTSTRAP_REPO_REQUIRED', 'Canonical EveOS repository root required.');
  let root;
  try { root = fs.realpathSync(path.resolve(repoRoot)); }
  catch { return fail('DEX_BOOTSTRAP_REPO_REQUIRED', 'EveOS repository root is not accessible.'); }
  let target;
  try {
    target = broker.createSession({ type: 'powershell', cwd: root, label: 'TLO Proof (no grants)' });
    if (!target?.id || !target?.processEpoch || path.normalize(target.cwd).toLowerCase() !== path.normalize(root).toLowerCase())
      throw new Error('Machine Spaces did not return a pinned managed PowerShell target.');
    const room = makeRoom({ name: roomName, requestId, idFactory, at: now(), target });
    snapshot.rooms.push(room);
    const saved = save(snapshot);
    broadcastState(saved);
    return response(room, broker, false);
  } catch (error) {
    if (target?.id) { try { broker.stopSession?.(target.id); } catch {} }
    return fail('DEX_BOOTSTRAP_ABORTED', `Setup failed before confirmation: ${String(error?.code || error?.message || 'unknown').slice(0, 140)}. Inspect before retry.`);
  }
}
module.exports = { PROOF_KIND, DEFAULT_NAME, TLO, proofRoom, makeRoom, response, bootstrap };
