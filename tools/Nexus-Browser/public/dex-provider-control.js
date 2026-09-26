(() => {
  const roomAdminApi = globalThis.BrowserAiBridgeDexRoomAdmin
    || (typeof module !== 'undefined' && module.exports ? require('./dex-room-admin.js') : null);
  const continuityApi = globalThis.BrowserAiBridgeDexAgentContinuity
    || (typeof module !== 'undefined' && module.exports ? require('./dex-agent-continuity.js') : null);
  const participantApi = globalThis.BrowserAiBridgeDexProviderParticipants
    || (typeof module !== 'undefined' && module.exports ? require('./dex-provider-participants.js') : null);
  const doneWatchApi = globalThis.BrowserAiBridgeDexDoneWatch
    || (typeof module !== 'undefined' && module.exports ? require('./dex-done-watch.js') : null);
  const membersApi = globalThis.BrowserAiBridgeDexMembers
    || (typeof module !== 'undefined' && module.exports ? require('./dex-members.js') : null);
  if (!roomAdminApi || !continuityApi || !participantApi || !membersApi || !doneWatchApi) throw new Error('Dex room admin, continuity, participant, and member helpers must load before provider control.');
  const SELECTION_KEY = 'browser-ai-bridge.dex.provider-control.v1';
  const ACTIONS = new Set([
    'help', 'onboard', 'checkpoint', 'read_checkpoint', 'rooms', 'targets', 'create_room', 'use_room', 'status',
    'rename_self', 'set_self_relay', 'clear_chat', 'delete_room', 'add_agent', 'spawn_agent', 'despawn_agent', 'send', 'handoff_room',
    'stop_relay', 'continue_relay', 'room_budget', 'set_room_budget', 'room_log', 'reload_extension', 'watch_done', 'unwatch_done',
    'arm_post_idle', 'post_idle_status', 'cancel_post_idle', 'report_post_idle', ...roomAdminApi.ACTIONS
  ]);
  const MUTATING_ACTIONS = new Set(['checkpoint','create_room','rename_room','configure_room','add_agent','spawn_agent','despawn_agent','rename_agent','set_agent_relay','remove_agent','rename_self','set_self_relay','stop_relay','continue_relay','set_room_budget','clear_chat','delete_room','send','handoff_room','reload_extension','watch_done','unwatch_done','arm_post_idle','cancel_post_idle','report_post_idle']);
  function clean(value, max = 16000) {
    return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }
  function sourceKey(source = {}) {
    if (source.targetClassId === 'local-origin') {
      return `local:${source.providerId || 'provider'}:${source.targetId || 'target'}`;
    }
    return `online:${source.providerId || 'provider'}:${source.url || source.targetId || 'target'}`;
  }
  function bindingMatchesSource(binding = {}, source = {}) {
    if (binding.targetClassId !== source.targetClassId) return false;
    if (source.targetClassId === 'local-origin') {
      if (String(binding.targetId || '') === String(source.targetId || '')) return true;
      return binding.providerId === 'local-antigravity-existing' && source.providerId === 'local-antigravity-existing';
    }
    if (binding.providerId !== source.providerId) return false;
    if (binding.targetId && source.targetId && String(binding.targetId) === String(source.targetId)) return true;
    if (binding.url && source.url) return binding.url === source.url;
    return String(binding.targetId || '') === String(source.targetId || '');
  }
  function memberForSource(room, source) {
    return (room?.members || []).find((member) => bindingMatchesSource(member.binding, source)) || null;
  }
  function authorizedRooms(rooms, source) {
    return (rooms || []).filter((room) => memberForSource(room, source));
  }
  function findRoom(rooms, ref) {
    const wanted = clean(ref, 120).toLowerCase();
    if (!wanted) return null;
    return rooms.find((room) => String(room.id) === ref)
      || rooms.find((room) => String(room.name || '').trim().toLowerCase() === wanted)
      || null;
  }
  function loadSelections(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    if (!storage) return {};
    try { return JSON.parse(storage.getItem(SELECTION_KEY) || '{}') || {}; }
    catch { return {}; }
  }
  function saveSelections(selections, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    if (!storage) return;
    try { storage.setItem(SELECTION_KEY, JSON.stringify(selections)); } catch {}
  }
  function compactTarget(targetClassId, target = {}) {
    return membersApi.bindingFromSource(targetClassId, target);
  }
  function bindingFromTarget(targetClassId, target = {}) {
    return membersApi.bindingFromSource(targetClassId, target);
  }
  function bindingFingerprint(binding = {}) {
    if (binding.targetClassId === 'online-origin' && binding.managedByDex === true) {
      return `online-managed:${binding.providerId || ''}:${binding.targetId || ''}`;
    }
    return binding.targetClassId === 'online-origin'
      ? `online:${binding.providerId || ''}:${binding.url || binding.targetId || ''}`
      : `local:${binding.providerId || ''}:${binding.targetId || ''}`;
  }
  function targetForCommand(state, command = {}) {
    const targetClassId = String(command.targetClassId || '').trim();
    const targetId = String(command.targetId ?? '').trim();
    if (!['online-origin', 'local-origin'].includes(targetClassId) || !targetId) return null;
    const pool = targetClassId === 'online-origin' ? state.tabs || [] : state.localTargets || [];
    return pool.find((target) => String(target.id) === targetId
      && (!command.providerId || target.providerId === command.providerId)) || null;
  }
  function roomBusy(_state, room) {
    if (!room) return false;
    return !!room.relay?.active
      || !!room.relay?.waitingFor
      || !!room.pendingTurn
      || !!room.recovery;
  }
  function clearRoomHistory(room) {
    if (!room) return 0;
    const cleared = Array.isArray(room.messages) ? room.messages.length : 0;
    room.messages = [];
    room.updatedAt = new Date().toISOString();
    if (room.relay) Object.assign(room.relay, { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Chat cleared' });
    return cleared;
  }
  function roomSummary(room, member, selected = false) {
    return {
      id: room.id,
      name: room.name,
      selected,
      participant: member?.name || null,
      members: (room.members || []).map((entry) => entry.name),
      memberDetails: (room.members || []).map((entry) => ({
        memberId: entry.id, name: entry.name, relayEnabled: entry.relayEnabled !== false,
        providerId: entry.binding?.providerId || null, targetClassId: entry.binding?.targetClassId || null
      })),
      relayActive: !!room.relay?.active,
      waitingFor: room.relay?.waitingFor || null,
      recoveryPending: !!room.recovery,
      recoveryDispatched: !!room.recovery?.dispatched,
      recoveryInterrupted: !!room.recovery?.interruptedAt,
      recoveryRequestId: room.recovery?.requestId || null, recoveryPassiveAt: room.recovery?.passiveAt || null, deferredSends: (room.deferredRelays || []).length, archivedLateFinalWatches: (room.lateFinalWatches || []).length,
      recoveryMemberId: room.recovery?.memberId || null,
      recoveryMemberName: (room.members || []).find((entry) => entry.id === room.recovery?.memberId)?.name || null,
      budget: { configuredTurns: room.settings?.maxTurns || 8, allocatedTurns: room.relay?.turnBudgetTotal || null, scheduledTurns: room.relay?.scheduledTurns ?? null, remainingTurns: room.relay?.remaining || 0 },
      messages: room.messages?.length || 0
    };
  }
  function onboardingData(room, member, providers = []) {
    const provider = providers.find((entry) => entry.id === member?.binding?.providerId) || null;
    return {
      room: {
        id: room.id,
        name: room.name,
        members: (room.members || []).map((entry) => ({
          memberId: entry.id,
          name: entry.name,
          targetClassId: entry.binding?.targetClassId || null,
          providerId: entry.binding?.providerId || null,
          providerName: entry.binding?.providerName || null,
          relayEnabled: entry.relayEnabled !== false
        }))
      },
      self: {
        memberId: member?.id || null,
        name: member?.name || null,
        targetClassId: member?.binding?.targetClassId || null,
        providerId: member?.binding?.providerId || null,
        providerName: member?.binding?.providerName || null,
        relayEnabled: member?.relayEnabled !== false
      },
      commands: ['rooms', 'targets', 'status', 'room_budget', 'set_room_budget', 'room_log', 'checkpoint', 'read_checkpoint', 'use_room', 'create_room', 'rename_room', 'configure_room', 'add_agent', 'spawn_agent', 'despawn_agent', 'rename_agent', 'set_agent_relay', 'remove_agent', 'rename_self', 'set_self_relay', 'stop_relay', 'continue_relay', 'clear_chat', 'delete_room', 'send', 'handoff_room', 'reload_extension', 'watch_done', 'unwatch_done'],
      spawnProviders: providers.filter((entry) => entry.orchestration?.spawnable).map((entry) => ({ providerId: entry.id, providerName: entry.name })),
      continuity: continuityApi.onboardingGuidance(room, member, provider),
      rules: [
        'Query rooms, targets, or status only when needed; do not poll or dump state every turn.',
        'Dex and its headed UI run on Drift localhost. Online agents control Dex through provider commands but do not gain direct localhost or private-repository access.',
        'Room relay context is intentionally bounded. Ask for missing context instead of assuming it.',
        'Normal relay replies must not impersonate another participant or rewrite Dex routing metadata.',
        'Managed browser workers are bounded resources. Use spawn_agent only for explicit idle rooms and despawn_agent before deleting their room.',
        'A bound browser chat may request reload_extension only for its exact idle room. This server-owned operation does not grant shell access and fails closed if another Dex room is busy.',
        'send with notifyOnDone:true lets the requester opt into one DONE notification. A finishing agent may instead append [[DEX:HEADSUP:<unique online room member>]] [[DEX:DONE]] to notify just that agent; no extra relay turn, automatic acknowledgement, or subscription. Both are optional.',
        'Disposable proof/test rooms are temporary resources. After the final idle status and managed-worker cleanup, delete the room with delete_room; do not leave one-use qualification rooms behind.'
      ]
    };
  }
  function createController({ state, roomMessage, startRelay, stopRoom, persist, renderAll, log, storage, createRoom, uid }) {
    const selections = loadSelections(storage);
    function setSelection(source, room) {
      selections[sourceKey(source)] = room.id;
      saveSelections(selections, storage);
    }
    function resolve(source, roomRef = null) {
      const rooms = authorizedRooms(state.rooms, source);
      if (!rooms.length) return { error: 'This provider chat/session is not bound to any Dex room.' };
      const explicit = roomRef ? findRoom(rooms, roomRef) : null;
      if (roomRef && !explicit) return { error: `No authorized Dex room matches ${roomRef}.` };
      if (explicit) return { room: explicit, member: memberForSource(explicit, source), rooms };
      const selectedId = selections[sourceKey(source)];
      const selected = rooms.find((room) => room.id === selectedId);
      if (selected) return { room: selected, member: memberForSource(selected, source), rooms };
      if (rooms.length === 1) {
        setSelection(source, rooms[0]);
        return { room: rooms[0], member: memberForSource(rooms[0], source), rooms };
      }
      return { error: 'This provider belongs to multiple Dex rooms. Use action use_room first.', rooms };
    }
    function help() {
      return {
        ok: true,
        action: 'help',
        message: 'Dex provider control is available from a bound provider chat/session.',
        data: {
          commands: [
            '[[DEX:CMD {"action":"onboard"}]]',
            '[[DEX:CMD {"action":"checkpoint","note":"<durable continuation note>"}]]',
            '[[DEX:CMD {"action":"read_checkpoint"}]]',
            '[[DEX:CMD {"action":"rooms"}]]',
            '[[DEX:CMD {"action":"targets"}]]',
            '[[DEX:CMD {"action":"create_room","name":"<room name>","disposable":true,"purpose":"managed-worker-proof"}]]',
            '[[DEX:CMD {"action":"use_room","room":"<room id or exact name>"}]]',
            '[[DEX:CMD {"action":"status"}]]',
            '[[DEX:CMD {"action":"room_budget"}]]', '[[DEX:CMD {"action":"set_room_budget","turns":12,"resume":true}]]', '[[DEX:CMD {"action":"room_log","limit":10,"before":"<optional id>"}]]',
            '[[DEX:CMD {"action":"rename_room","room":"<room>","name":"<new name>"}]]',
            '[[DEX:CMD {"action":"configure_room","room":"<room>","maxTurns":8,"contextDefaultMessages":2,"autoRelay":true}]]',
            '[[DEX:CMD {"action":"rename_agent","room":"<room>","member":"<member id>","name":"<name>"}]]',
            '[[DEX:CMD {"action":"set_agent_relay","room":"<room>","member":"<member id>","enabled":false}]]',
            '[[DEX:CMD {"action":"remove_agent","room":"<room>","member":"<member id>"}]]',
            '[[DEX:CMD {"action":"stop_relay","room":"<room>"}]]',
            '[[DEX:CMD {"action":"continue_relay","room":"<room>","turns":8}]]',
            '[[DEX:CMD {"action":"rename_self","name":"<new room name>"}]]',
            '[[DEX:CMD {"action":"set_self_relay","enabled":false}]]',
            '[[DEX:CMD {"action":"clear_chat","room":"<room id or exact name>"}]]',
            '[[DEX:CMD {"action":"delete_room","room":"<room id or exact name>"}]]',
            '[[DEX:CMD {"action":"add_agent","room":"<room>","targetClassId":"online-origin","targetId":"<target id>","name":"<agent name>"}]]',
            '[[DEX:CMD {"action":"spawn_agent","room":"<room>","providerId":"<spawnable provider id>","name":"<worker name>"}]]',
            '[[DEX:CMD {"action":"despawn_agent","room":"<room>","member":"<managed member id or name>"}]]',
            '[[DEX:CMD {"action":"send","text":"<message>","contextMessages":6,"relay":true,"notifyOnDone":true,"notifyMember":"<optional exact member name or id>"}]]',
            '[[DEX:CMD {"action":"watch_done","room":"<room id>","member":"<optional exact member name or id>"}]]',
            '[[DEX:CMD {"action":"unwatch_done","room":"<room id>"}]]',
            '[[DEX:CMD {"action":"handoff_room","room":"<authorized room id or exact name>","text":"<message>","turns":8}]]',
            '[[DEX:CMD {"action":"reload_extension","room":"<exact authorized room id>"}]]'
          ],
          note: 'Commands are trailing-only. Browser providers are authorized only for rooms containing that exact provider chat; local agents are authorized only for their exact local target.'
        }
      };
    }
    function handle(request = {}) {
      const source = request.source || {};
      const command = request.command || {};
      const action = String(command.action || '').trim().toLowerCase();
      if (!ACTIONS.has(action)) return { ok: false, code: 'DEX_CONTROL_BAD_ACTION', message: `Unsupported Dex provider-control action: ${action || '(missing)'}` };
      if (!source.targetClassId || !source.providerId) return { ok: false, code: 'DEX_CONTROL_BAD_SOURCE', message: 'Provider-control source identity is incomplete.' };
      if (action === 'help') return help();
      if (['reload_extension', 'watch_done', 'unwatch_done', 'arm_post_idle', 'post_idle_status', 'cancel_post_idle', 'report_post_idle', 'room_budget', 'set_room_budget', 'room_log'].includes(action)) return { ok: false, code: 'DEX_CONTROL_SERVER_ONLY', message: `${action} is owned by the localhost provider-control router.` };
      if (action === 'create_room') {
        if (typeof createRoom !== 'function') {
          return { ok: false, code: 'DEX_CONTROL_CREATE_UNAVAILABLE', message: 'Dex room creation is unavailable in this runtime.' };
        }
        const room = createRoom();
        room.name = clean(command.name || room.name, 80) || room.name;
        if (command.userName) room.userName = clean(command.userName, 48) || room.userName;
        if (command.disposable === true) room.lifecycle = { disposable: true, kind: clean(command.purpose || 'managed-worker-proof', 80) || 'managed-worker-proof', createdBy: 'provider-control' };
        const sourceBinding = bindingFromTarget(source.targetClassId, { ...source, id: source.targetId });
        room.members.push({
          id: typeof uid === 'function' ? uid('agent') : `agent-${Date.now().toString(36)}`,
          name: clean(command.selfName || source.providerName || source.title || 'Agent', 48),
          binding: sourceBinding
        });
        state.rooms.push(room);
        state.activeRoomId = room.id;
        setSelection(source, room);
        persist();
        renderAll();
        log?.(`Provider control created ${room.name} with ${room.members[0].name} as the first participant.`);
        return { ok: true, action, message: `Created Dex room: ${room.name}`, data: roomSummary(room, room.members[0], true) };
      }
      const rooms = authorizedRooms(state.rooms, source);
      if (!rooms.length) return { ok: false, code: 'DEX_CONTROL_NOT_BOUND', message: 'This exact provider chat/session is not a participant in any Dex room.' };
      if (action === 'rooms') {
        const selectedId = selections[sourceKey(source)] || (rooms.length === 1 ? rooms[0].id : null);
        if (rooms.length === 1 && !selections[sourceKey(source)]) setSelection(source, rooms[0]);
        return {
          ok: true,
          action,
          message: `${rooms.length} authorized Dex room${rooms.length === 1 ? '' : 's'} found.`,
          data: { rooms: rooms.map((room) => roomSummary(room, memberForSource(room, source), room.id === selectedId)) }
        };
      }
      if (action === 'targets') {
        return {
          ok: true,
          action,
          message: 'Visible Dex targets snapshot.',
          data: {
            online: (state.tabs || []).map((target) => compactTarget('online-origin', target)),
            local: (state.localTargets || []).map((target) => compactTarget('local-origin', target))
          }
        };
      }
      if (action === 'use_room') {
        const room = findRoom(rooms, command.room);
        if (!room) return { ok: false, code: 'DEX_CONTROL_ROOM_NOT_FOUND', message: 'That room is not available to this provider chat/session.' };
        setSelection(source, room);
        return { ok: true, action, message: `Selected Dex room: ${room.name}`, data: roomSummary(room, memberForSource(room, source), true) };
      }
      if ((action === 'delete_room' || action === 'handoff_room') && !clean(command.room, 120)) {
        return { ok: false, code: 'DEX_CONTROL_ROOM_REQUIRED', message: `${action} requires an explicit room id or exact name.` };
      }
      const resolved = resolve(source, command.room || null);
      if (!resolved.room) {
        return {
          ok: false,
          code: 'DEX_CONTROL_ROOM_REQUIRED',
          message: resolved.error,
          data: resolved.rooms ? { rooms: resolved.rooms.map((room) => roomSummary(room, memberForSource(room, source), false)) } : null
        };
      }
      const { room, member } = resolved;
      if (command.room) setSelection(source, room);
      if (action === 'onboard') {
        return { ok: true, action, message: `Dex onboarding for ${member?.name || 'this agent'} in ${room.name}.`, data: onboardingData(room, member, state.providers || []) };
      }
      if (action === 'checkpoint') {
        const result = continuityApi.writeCheckpoint(room, member, command.note);
        if (!result.ok) return { ...result, action };
        persist(); renderAll(); log?.(`Checkpoint saved for ${member.name} in ${room.name}.`);
        return { ok: true, action, message: `Saved durable checkpoint for ${member.name}.`, data: { checkpoint: continuityApi.compact(result.checkpoint) } };
      }
      if (action === 'read_checkpoint') {
        const checkpoint = continuityApi.compact(continuityApi.checkpointFor(room, member?.id));
        return { ok: true, action, message: checkpoint ? `Loaded durable checkpoint for ${member.name}.` : `No durable checkpoint is saved for ${member?.name || 'this agent'}.`, data: { checkpoint } };
      }
      if (action === 'rename_self') {
        const name = clean(command.name, 48);
        if (!name) return { ok: false, code: 'DEX_CONTROL_NAME_REQUIRED', message: 'rename_self requires a non-empty name.' };
        member.name = name; room.updatedAt = new Date().toISOString(); persist(); renderAll();
        return { ok: true, action, message: `Renamed this room participant to ${name}.`, data: roomSummary(room, member, true) };
      }
      if (action === 'set_self_relay') {
        member.relayEnabled = command.enabled !== false;
        room.updatedAt = new Date().toISOString(); persist(); renderAll();
        return { ok: true, action, message: `${member.name} is now ${member.relayEnabled ? 'participating in' : 'observing'} relay turns.`, data: { roomId: room.id, memberId: member.id, relayEnabled: member.relayEnabled } };
      }
      if (action === 'handoff_room') {
        const text = clean(command.text);
        if (!text) return { ok: false, code: 'DEX_CONTROL_EMPTY_MESSAGE', message: 'handoff_room requires non-empty text.' };
        if (roomBusy(state, room)) return { ok: false, code: 'DEX_CONTROL_ROOM_BUSY', message: `Dex room ${room.name} is already busy.`, data: { commitState: 'not_committed', commitId: null } };
        const busySources = rooms.filter((entry) => entry.id !== room.id && roomBusy(state, entry));
        if (busySources.length > 1) return { ok: false, code: 'DEX_CONTROL_HANDOFF_AMBIGUOUS', message: 'More than one other authorized room is busy for this provider chat; refusing to guess which room to stop.' };
        if (busySources.length === 1) {
          if (typeof stopRoom !== 'function' || !stopRoom(busySources[0], `Handed off by ${memberForSource(busySources[0], source)?.name || member.name} to ${room.name}`)) {
            return { ok: false, code: 'DEX_CONTROL_HANDOFF_STOP_FAILED', message: 'Could not stop the current Dex room before handoff.' };
          }
        }
        const message = roomMessage(room, 'agent', member.id, member.name, text, false); if (Number.isInteger(command.contextMessages) && command.contextMessages >= 1 && command.contextMessages <= 40) message.contextOverride = command.contextMessages;
        const turns = Math.max(1, Math.min(roomAdminApi.protocol?.MAX_RELAY_TURNS || 500, Number.parseInt(command.turns, 10) || room.settings?.maxTurns || 8));
        if (typeof startRelay !== 'function' || !startRelay(room, message, turns)) {
          if ((room.messages || []).at(-1) === message) room.messages.pop();
          renderAll();
          return { ok: false, code: 'DEX_CONTROL_HANDOFF_START_FAILED', message: `Could not start ${room.name} after stopping the prior room.` };
        }
        setSelection(source, room);
        log?.(`Provider control handed ${member.name} off to ${room.name}.`);
        return { ok: true, silent: true, action, message: `Handed off to ${room.name} and started relay.`, data: { roomId: room.id, messageId: message.id, commitId: message.id, commitState: 'committed', turns } };
      }
      if (action === 'status') {
        const latest = (room.messages || []).slice(-3).map((message) => ({
          sender: message.senderName || message.senderKind,
          kind: message.senderKind,
          text: clean(message.text, 400)
        }));
        return { ok: true, action, message: `Dex room ${room.name} status.`, data: { ...roomSummary(room, member, true), checkpoint: continuityApi.compact(continuityApi.checkpointFor(room, member?.id)), doneWatch: doneWatchApi.summary(room, member?.id), latest } };
      }
      if (action === 'stop_relay') {
        if (typeof stopRoom !== 'function') return { ok: false, code: 'DEX_CONTROL_STOP_UNAVAILABLE', message: 'Relay stop is unavailable in this runtime.' };
        stopRoom(room, `Stopped by ${member.name}`); renderAll();
        return { ok: true, action, message: `Stopped relay for ${room.name}.`, data: roomSummary(room, member, true) };
      }
      if (action === 'continue_relay') {
        if (roomBusy(state, room)) return { ok: false, code: 'DEX_CONTROL_ROOM_BUSY', message: `Dex room ${room.name} is already busy.` };
        const sourceMessage = (room.messages || []).at(-1);
        if (!sourceMessage) return { ok: false, code: 'DEX_CONTROL_NO_MESSAGES', message: 'continue_relay requires at least one room message.' };
        const turns = Math.max(1, Math.min(roomAdminApi.protocol?.MAX_RELAY_TURNS || 500, Number.parseInt(command.turns, 10) || room.settings?.maxTurns || 8));
        startRelay(room, sourceMessage, turns);
        return { ok: true, silent: true, action, message: `Continued ${room.name} for up to ${turns} turn(s).`, data: { roomId: room.id, turns } };
      }
      if (roomAdminApi.ACTIONS.has(action)) {
        if (roomBusy(state, room)) return { ok: false, code: 'DEX_CONTROL_ROOM_BUSY', message: `Dex room ${room.name} is busy. Stop the relay before changing room structure.` };
        if (action === 'remove_agent' && roomAdminApi.resolveMember(room, command.member).member?.binding?.managedByDex === true) return { ok: false, code: 'DEX_CONTROL_MANAGED_AGENT', message: 'Use despawn_agent for Dex-managed browser workers so their tab is closed safely.' };
        const result = roomAdminApi.handle(action, room, command);
        if (!result?.ok) return { ...result, action };
        if (action === 'remove_agent' && result.member) delete selections[sourceKey(result.member.binding)];
        saveSelections(selections, storage); persist(); renderAll(); log?.(`Provider control: ${result.message}`);
        return { ok: true, action, message: result.message, data: roomSummary(room, memberForSource(room, source), true) };
      }
      if (action === 'clear_chat') {
        if (roomBusy(state, room)) return { ok: false, code: 'DEX_CONTROL_ROOM_BUSY', message: `Dex room ${room.name} is busy. Stop the relay before clearing chat.` };
        const cleared = clearRoomHistory(room);
        persist(); renderAll(); log?.(`Provider control cleared ${cleared} message(s) from ${room.name}.`);
        return { ok: true, action, message: `Cleared ${cleared} message(s) from ${room.name}.`, data: roomSummary(room, member, true) };
      }
      if (action === 'delete_room') {
        if (roomBusy(state, room)) return { ok: false, code: 'DEX_CONTROL_ROOM_BUSY', message: `Dex room ${room.name} is busy. Stop the relay before deleting it.` };
        if ((room.members || []).some((entry) => entry.binding?.managedByDex === true)) return { ok: false, code: 'DEX_CONTROL_MANAGED_WORKERS_PRESENT', message: 'Despawn managed browser workers before deleting their room.' };
        if (state.rooms.length === 1 && typeof createRoom !== 'function') {
          return { ok: false, code: 'DEX_CONTROL_DELETE_UNAVAILABLE', message: 'Cannot delete the final room without a room factory.' };
        }
        const deleted = { id: room.id, name: room.name };
        state.rooms = state.rooms.filter((entry) => entry.id !== room.id);
        for (const key of Object.keys(selections)) if (selections[key] === room.id) delete selections[key];
        saveSelections(selections, storage);
        if (!state.rooms.length) state.rooms.push(createRoom());
        if (!state.rooms.some((entry) => entry.id === state.activeRoomId)) state.activeRoomId = state.rooms[0].id;
        persist(); renderAll(); log?.(`Provider control deleted room ${deleted.name}.`);
        return { ok: true, action, message: `Deleted Dex room: ${deleted.name}`, data: { deletedRoomId: deleted.id, activeRoomId: state.activeRoomId, remainingRooms: state.rooms.length } };
      }
      const participantResult = participantApi.handle({
        action, state, room, selectedMember: member, command, roomBusy, targetForCommand,
        bindingFromTarget, bindingFingerprint, clean, uid, persist, renderAll, log, roomSummary,
        resolveMember: roomAdminApi.resolveMember
      });
      if (participantResult) return participantResult;
      const text = clean(command.text);
      if (!text) return { ok: false, code: 'DEX_CONTROL_EMPTY_MESSAGE', message: 'send requires non-empty text.' }; if (command.contextMessages != null && (!Number.isInteger(command.contextMessages) || command.contextMessages < 1 || command.contextMessages > 40)) return { ok: false, code: 'DEX_CONTEXT_INVALID', message: 'contextMessages must be 1–40.' };
      if (roomBusy(state, room)) return { ok: false, code: 'DEX_CONTROL_ROOM_BUSY', message: `Dex room ${room.name} is already relaying. Wait for it to stop before initiating an out-of-band provider message.` };
      const priorWatch = doneWatchApi.snapshot(room);
      const enrollment = doneWatchApi.armSend(room, member, command, uid);
      if (!enrollment.ok) return enrollment;
      const message = roomMessage(room, 'agent', member.id, member.name, text, false); if (command.contextMessages != null) message.contextOverride = command.contextMessages;
      if (command.relay === false) {
        persist();
        renderAll();
        log?.(`Provider control recorded note from ${member.name} in ${room.name}.`);
        return { ok: true, silent: true, action, message: `Recorded message in ${room.name} without starting relay.`, data: { roomId: room.id, messageId: message.id } };
      }
      if (startRelay(room, message) === false) {
        room.messages.pop(); doneWatchApi.restore(room, priorWatch);
        return { ok: false, code: 'DEX_CONTROL_RELAY_START_FAILED', message: 'Relay could not start; no DONE watcher was armed.' };
      }
      log?.(`Provider control started ${room.name} from ${member.name}.`);
      return { ok: true, silent: true, action, message: `Sent to ${room.name} and started relay.`, data: { roomId: room.id, messageId: message.id } };
    }
    return { handle, authorizedRooms: (source) => authorizedRooms(state.rooms, source), resolve };
  }
  const api = {
    SELECTION_KEY,
    ACTIONS, MUTATING_ACTIONS,
    sourceKey,
    bindingMatchesSource,
    memberForSource,
    authorizedRooms,
    findRoom,
    roomSummary,
    onboardingData,
    roomBusy,
    clearRoomHistory,
    compactTarget,
    bindingFromTarget,
    bindingFingerprint,
    targetForCommand,
    createController
  };
  globalThis.BrowserAiBridgeDexProviderControl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
