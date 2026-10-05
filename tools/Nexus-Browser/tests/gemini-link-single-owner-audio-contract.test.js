'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stateApi = require('../dex/server-scheduler-state');
const { createServerLocalRelay } = require('../dex/server-local-relay');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('Dex local relay carries exact room/turn/request/source-message identity', async () => {
  const requestId = 'dex-turn-correlation-contract';
  const room = { id: 'room-correlation-contract', relay: { active: true, remaining: 2 } };
  const member = {
    id: 'member-gemini',
    binding: {
      targetClassId: 'local-origin',
      targetId: 'local:gemini-link-chat:default',
      providerId: 'gemini-link-chat'
    }
  };
  const current = {
    requestId,
    roomId: room.id,
    sourceMessageId: 'msg-source-contract',
    inboxMessageIds: [],
    retryCount: 0
  };

  stateApi.createRecoveryJournal(current, member, room, new Date().toISOString());
  assert.deepEqual(stateApi.correlationForRequest(requestId), {
    roomId: room.id,
    turnId: requestId,
    requestId,
    sourceMessageId: current.sourceMessageId
  });

  let forwarded = null;
  const relay = createServerLocalRelay({
    localTargets: {
      async getLocalTarget() {
        return { id: member.binding.targetId, providerId: member.binding.providerId };
      },
      async sendLocalPrompt(input) {
        forwarded = input;
      }
    }
  });

  await relay.sendLocalPrompt({
    targetId: member.binding.targetId,
    requestId,
    text: 'correlation contract',
    emit() {}
  });

  assert.deepEqual(forwarded.correlation, {
    roomId: room.id,
    turnId: requestId,
    requestId,
    sourceMessageId: current.sourceMessageId
  });
  assert.equal(stateApi.correlationForRequest(requestId), null, 'settled relay leaked its correlation registration');
});

test('Nexus-origin Gemini Live audio is published once and native playback is suppressed for that turn only', () => {
  const bridge = read(
    'server', 'gemini-backend', 'interactions', 'main_server_files',
    'websocket_server', 'session_handler', 'nexus_workspace_bridge.py'
  );
  const response = read(
    'server', 'gemini-backend', 'interactions', 'main_server_files',
    'response_processing', 'response_handler.py'
  );
  const sessionHandler = read(
    'server', 'gemini-backend', 'interactions', 'main_server_files',
    'websocket_server', 'gemini_session_handler.py'
  );

  assert.match(bridge, /def nexus_owns_audio\(connection_id\):/);
  assert.match(response, /and nexus_owns_audio\(self\.connection_id\)/);
  assert.match(response, /await publish_nexus_audio\(self\.connection_id, audio_data\)/);
  assert.match(response, /self\.audio_processor\.audio_data \+= audio_data/);

  const ownedBranch = response.indexOf('            if nexus_owned:');
  const ownedReturn = response.indexOf('                return', ownedBranch);
  const nativePlayback = response.indexOf('            await self.audio_processor.process_audio_data', ownedBranch);
  assert.ok(ownedBranch >= 0 && ownedReturn > ownedBranch && nativePlayback > ownedReturn,
    'Nexus-owned audio must return before the native Gemini Link playback send');

  assert.match(sessionHandler, /if session_role != "nexus_chat":/);
  assert.match(sessionHandler, /await execute_nexus_chat_session\(/);
});

test('existing Nexus Gemini audio UI associates PCM with the matching assistant reply and exposes controls', () => {
  const audioUi = read('tools', 'Nexus-Browser', 'public', 'gemini-link-audio.js');
  assert.match(audioUi, /message\?\.providerId !== 'gemini-link-chat'/);
  assert.match(audioUi, /message\.type === 'response_audio'/);
  assert.match(audioUi, /const requestId = String\(message\.requestId \|\| ''\)/);
  assert.ok(audioUi.includes('assistant-${CSS.escape(requestId)}'), 'audio is not attached by the matching request id');
  assert.match(audioUi, /data-gemini-audio-play/);
  assert.match(audioUi, /scheduleReplayAttach\(requestId\)/);
});