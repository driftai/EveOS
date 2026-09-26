(() => {
  const protocol = globalThis.BrowserAiBridgeDexProtocol
    || (typeof module !== 'undefined' && module.exports ? require('./dex-protocol.js') : null);
  if (!protocol) throw new Error('Dex protocol must load before room admin.');
  const ACTIONS = new Set([
    'rename_room', 'configure_room', 'rename_agent', 'set_agent_relay', 'remove_agent'
  ]);

  function clean(value, max = 16000) {
    return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  }

  function resolveMember(room, ref) {
    const wanted = clean(ref, 120);
    if (!wanted) return { error: 'A member id or exact name is required.' };
    const byId = (room?.members || []).find((member) => String(member.id) === wanted);
    if (byId) return { member: byId };
    const matches = (room?.members || []).filter((member) =>
      String(member.name || '').trim().toLowerCase() === wanted.toLowerCase()
    );
    if (matches.length === 1) return { member: matches[0] };
    if (matches.length > 1) return { error: 'That agent name is ambiguous. Use the member id from room status.' };
    return { error: 'No room participant matches that member id or exact name.' };
  }

  function touch(room) {
    room.updatedAt = new Date().toISOString();
  }

  function renameRoom(room, command = {}) {
    const name = clean(command.name, 80);
    if (!name) return { ok: false, code: 'DEX_CONTROL_NAME_REQUIRED', message: 'rename_room requires a non-empty name.' };
    room.name = name;
    touch(room);
    return { ok: true, message: `Renamed Dex room to ${name}.` };
  }

  function configureRoom(room, command = {}) {
    const settings = room.settings || (room.settings = {});
    let changed = 0;
    if (typeof command.autoRelay === 'boolean') { settings.autoRelay = command.autoRelay; changed += 1; }
    if (command.maxTurns != null) {
      const value = Number.parseInt(command.maxTurns, 10);
      if (!Number.isFinite(value)) return { ok: false, code: 'DEX_CONTROL_BAD_SETTING', message: 'maxTurns must be an integer.' };
      settings.maxTurns = Math.max(1, Math.min(protocol.MAX_RELAY_TURNS, value)); settings.budgetRevision = Number(settings.budgetRevision || 0) + 1; changed += 1;
    }
    if (command.contextMessages != null) {
      const value = Number.parseInt(command.contextMessages, 10);
      if (!Number.isFinite(value)) return { ok: false, code: 'DEX_CONTROL_BAD_SETTING', message: 'contextMessages must be an integer.' };
      settings.contextMessages = Math.max(2, Math.min(20, value)); settings.contextDefaultMessages = settings.contextMessages; changed += 1;
    }
    if (command.contextDefaultMessages != null) {
      const n = Number(command.contextDefaultMessages);
      if (!Number.isInteger(n) || n < 1 || n > 40) return { ok: false, code: 'DEX_CONTROL_BAD_SETTING', message: 'contextDefaultMessages must be an integer between 1 and 40.' };
      settings.contextDefaultMessages = n; changed += 1;
    }
    if (command.userName != null) {
      const value = clean(command.userName, 48);
      if (!value) return { ok: false, code: 'DEX_CONTROL_BAD_SETTING', message: 'userName cannot be empty.' };
      room.userName = value; changed += 1;
    }
    if (!changed) {
      return { ok: false, code: 'DEX_CONTROL_BAD_SETTING', message: 'configure_room requires autoRelay, maxTurns, contextDefaultMessages, or userName.' };
    }
    touch(room);
    return { ok: true, message: `Updated settings for ${room.name}.` };
  }

  function renameAgent(room, command = {}) {
    const resolved = resolveMember(room, command.member);
    if (!resolved.member) return { ok: false, code: 'DEX_CONTROL_MEMBER_NOT_FOUND', message: resolved.error };
    const name = clean(command.name, 48);
    if (!name) return { ok: false, code: 'DEX_CONTROL_NAME_REQUIRED', message: 'rename_agent requires a non-empty name.' };
    resolved.member.name = name;
    if (room.agentCheckpoints?.[resolved.member.id]) room.agentCheckpoints[resolved.member.id].memberName = name;
    touch(room);
    return { ok: true, member: resolved.member, message: `Renamed room participant to ${name}.` };
  }

  function setAgentRelay(room, command = {}) {
    const resolved = resolveMember(room, command.member);
    if (!resolved.member) return { ok: false, code: 'DEX_CONTROL_MEMBER_NOT_FOUND', message: resolved.error };
    if (typeof command.enabled !== 'boolean') {
      return { ok: false, code: 'DEX_CONTROL_BAD_SETTING', message: 'set_agent_relay requires enabled=true or false.' };
    }
    resolved.member.relayEnabled = command.enabled;
    touch(room);
    return {
      ok: true, member: resolved.member,
      message: `${resolved.member.name} is now ${command.enabled ? 'participating in' : 'observing'} relay turns.`
    };
  }

  function removeAgent(room, command = {}) {
    if ((room?.members || []).length <= 1) {
      return { ok: false, code: 'DEX_CONTROL_LAST_AGENT', message: 'Cannot remove the final participant from a room. Delete the room instead.' };
    }
    const resolved = resolveMember(room, command.member);
    if (!resolved.member) return { ok: false, code: 'DEX_CONTROL_MEMBER_NOT_FOUND', message: resolved.error };
    room.members = room.members.filter((member) => member.id !== resolved.member.id);
    if (room.agentCheckpoints) delete room.agentCheckpoints[resolved.member.id];
    touch(room);
    return { ok: true, member: resolved.member, message: `Removed ${resolved.member.name} from ${room.name}.` };
  }

  function handle(action, room, command) {
    if (!ACTIONS.has(action)) return null;
    if (action === 'rename_room') return renameRoom(room, command);
    if (action === 'configure_room') return configureRoom(room, command);
    if (action === 'rename_agent') return renameAgent(room, command);
    if (action === 'set_agent_relay') return setAgentRelay(room, command);
    return removeAgent(room, command);
  }

  const api = {
    protocol,
    ACTIONS, resolveMember, renameRoom, configureRoom, renameAgent, setAgentRelay, removeAgent, handle
  };
  globalThis.BrowserAiBridgeDexRoomAdmin = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
