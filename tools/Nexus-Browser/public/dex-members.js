(() => {
  // One policy for browser UI, localhost commands, receipt correlation and
  // terminal sources. Matching only an ID OR URL can select the wrong chat.
  function exactBinding(binding = {}, source = {}) {
    if (binding.targetClassId !== source.targetClassId
      || binding.providerId !== source.providerId) return false;
    if (binding.targetClassId === 'local-origin')
      return !!binding.targetId && String(binding.targetId) === String(source.targetId ?? '');
    if (binding.targetClassId !== 'online-origin') return false;
    const hasId = binding.targetId != null && String(binding.targetId) !== '';
    if (hasId && (source.targetId == null
      || String(binding.targetId) !== String(source.targetId))) return false;
    if (binding.url && binding.url !== source.url) return false;
    return hasId || !!binding.url;
  }
  function staleBinding(binding = {}, source = {}) {
    if (binding.targetClassId !== 'online-origin' || source.targetClassId !== 'online-origin'
      || binding.providerId !== source.providerId || exactBinding(binding, source)) return false;
    return (binding.targetId != null && source.targetId != null
      && String(binding.targetId) === String(source.targetId))
      || (!!binding.url && !!source.url && binding.url === source.url);
  }
  function staleRoomCount(rooms = [], source = {}, reference = null) {
    const ref = reference == null ? '' : String(reference).trim().toLowerCase();
    return (rooms || []).filter(room => (!ref || room?.id === reference
      || String(room?.name || '').trim().toLowerCase() === ref)
      && (room?.members || []).some(member => staleBinding(member.binding, source))).length;
  }

  function memberFingerprint(binding = {}) {
    return binding.targetClassId === 'online-origin'
      ? `online:${binding.providerId}:${binding.url || binding.targetId}`
      : `local:${binding.providerId}:${binding.targetId}`;
  }

  function stableMemberId(binding) {
    const text = memberFingerprint(binding);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    return `agent-${(hash >>> 0).toString(16)}`;
  }

  function bindingFromSource(targetClassId, source = {}) {
    const shared = {
      targetClassId,
      targetId: source.id,
      targetTypeId: source.targetTypeId || (targetClassId === 'online-origin' ? 'browser-tab' : ''),
      targetTypeName: source.targetTypeName || (targetClassId === 'online-origin' ? 'Browser Tab' : ''),
      providerId: source.providerId,
      providerName: source.providerName,
      title: source.title,
      transport: source.transport || (targetClassId === 'online-origin' ? 'browser-extension' : ''),
      sessionOrigin: source.sessionOrigin || (targetClassId === 'online-origin' ? 'browser' : ''),
      concreteTargetIdentity: source.concreteTargetIdentity ? { ...source.concreteTargetIdentity } : null,
      capabilities: { ...(source.capabilities || {}) }
    };
    if (targetClassId === 'online-origin') {
      return {
        ...shared,
        url: source.url,
      };
    }
    return shared;
  }

  function memberTypeId(binding = {}) {
    return binding.targetClassId === 'local-origin'
      ? binding.targetTypeId || ''
      : binding.providerId || '';
  }

  function availableTargetId(binding = {}, tabs = [], localTargets = []) {
    if (binding.targetClassId === 'local-origin') {
      return String(localTargets.find((target) => target.id === binding.targetId)?.id || '');
    }
    const target = tabs.find(tab => exactBinding(binding, { targetClassId: 'online-origin',
      targetId: tab.id, providerId: tab.providerId, url: tab.url }))
      || tabs.find(tab => tab.providerId === binding.providerId && binding.url && tab.url === binding.url);
    return target ? String(target.id) : '';
  }

  function hasBindingConflict(members = [], binding, exceptMemberId = null) {
    const fingerprint = memberFingerprint(binding);
    return members.some((member) => member.id !== exceptMemberId && memberFingerprint(member.binding) === fingerprint);
  }

  function rebindMember(member, name, binding, relayEnabled = member?.relayEnabled !== false) {
    return { ...member, id: member.id, name, binding, relayEnabled };
  }

  function createController({ state, el, protocol, activeRoom, persist, log, renderAll, uid, canHumanEdit = () => true }) {
    let editingMemberId = null;

    function mutationBlocked(room) {
      return !canHumanEdit() || !room || !!room.relay?.active || !!room.relay?.waitingFor || !!room.pendingTurn || !!room.recovery;
    }

    function clear() {
      editingMemberId = null;
      el.dexMemberName.value = '';
      el.dexMemberRelayEnabled.checked = true;
    }

    function renderBuilder(preferred = {}) {
      const room = activeRoom();
      if (!room) return;
      const targetClass = preferred.targetClassId || el.dexMemberClass.value || 'online-origin';
      el.dexMemberClass.value = targetClass;
      const previousType = preferred.typeId ?? el.dexMemberType.value;
      const previousTarget = preferred.targetId ?? el.dexMemberTarget.value;
      el.dexMemberType.replaceChildren();
      const typeOptions = targetClass === 'online-origin'
        ? (state.providers.length ? state.providers : [...new Map(state.tabs.map((tab) => [tab.providerId, { id: tab.providerId, name: tab.providerName }])).values()])
        : state.localTypes;
      for (const type of typeOptions) el.dexMemberType.add(new Option(type.name, type.id));
      if ([...el.dexMemberType.options].some((option) => option.value === previousType)) {
        el.dexMemberType.value = previousType;
      }
      el.dexMemberTarget.replaceChildren();
      const selectedType = el.dexMemberType.value;
      const targets = targetClass === 'online-origin'
        ? state.tabs.filter((tab) => tab.providerId === selectedType)
        : state.localTargets.filter((target) => !selectedType || target.targetTypeId === selectedType);
      for (const target of targets) {
        const label = targetClass === 'online-origin'
          ? `${target.title || target.providerName} — ${target.url}`
          : target.title;
        el.dexMemberTarget.add(new Option(label, String(target.id)));
      }
      if ([...el.dexMemberTarget.options].some((option) => option.value === previousTarget)) {
        el.dexMemberTarget.value = previousTarget;
      } else if (editingMemberId) {
        el.dexMemberTarget.add(new Option('Choose replacement chat / agent…', ''), 0);
        el.dexMemberTarget.value = '';
      }
    }

    function beginEdit(room, member) {
      if (!canHumanEdit()) return log('Enable Human Input before editing participants.');
      if (mutationBlocked(room)) return log('Stop the relay before editing participants.');
      editingMemberId = member.id;
      const binding = member.binding || {};
      el.dexMemberName.value = member.name;
      el.dexMemberRelayEnabled.checked = member.relayEnabled !== false;
      renderBuilder({
        targetClassId: binding.targetClassId || 'online-origin',
        typeId: memberTypeId(binding),
        targetId: availableTargetId(binding, state.tabs, state.localTargets)
      });
      renderAll();
    }

    function renderMembers(room) {
      el.dexMemberList.replaceChildren();
      for (const member of room?.members || []) {
        const row = document.createElement('div');
        row.className = `dex-member${member.id === editingMemberId ? ' editing' : ''}`;
        const text = document.createElement('div');
        text.innerHTML = `<strong></strong><span></span>`;
        text.querySelector('strong').textContent = member.name;
        const binding = member.binding || {};
        const surface = binding.targetTypeName || binding.targetTypeId || (binding.targetClassId === 'local-origin' ? 'Local target' : 'Browser tab');
        text.querySelector('span').textContent = ` ${binding.targetClassId === 'local-origin' ? 'Local' : 'Online'} · ${surface} · ${binding.providerName || binding.providerId} · ${member.relayEnabled === false ? 'Observer · ' : ''}${binding.title || binding.url || binding.targetId}`;
        const actions = document.createElement('div');
        actions.className = 'dex-member-actions';
        const edit = document.createElement('button');
        edit.className = 'secondary';
        edit.textContent = 'Edit';
        edit.disabled = mutationBlocked(room);
        edit.addEventListener('click', () => beginEdit(room, member));
        const remove = document.createElement('button');
        remove.className = 'secondary';
        remove.textContent = 'Remove';
        remove.disabled = mutationBlocked(room);
        remove.addEventListener('click', () => {
          if (!canHumanEdit()) return log('Enable Human Input before changing participants.');
          if (mutationBlocked(room)) return log('Stop the relay before changing participants.');
          room.members = room.members.filter((item) => item.id !== member.id);
          if (room.agentCheckpoints) delete room.agentCheckpoints[member.id];
          if (editingMemberId === member.id) clear();
          persist();
          renderAll();
        });
        actions.append(edit, remove);
        row.append(text, actions);
        el.dexMemberList.append(row);
      }
    }

    function saveParticipant() {
      const room = activeRoom();
      if (mutationBlocked(room)) return;
      const targetClassId = el.dexMemberClass.value;
      const targetId = el.dexMemberTarget.value;
      const source = targetClassId === 'online-origin'
        ? state.tabs.find((tab) => String(tab.id) === targetId)
        : state.localTargets.find((target) => target.id === targetId);
      if (!source) return log('Choose an available target first.');
      const binding = bindingFromSource(targetClassId, source);
      const existing = room.members.find((member) => member.id === editingMemberId) || null;
      if (hasBindingConflict(room.members, binding, existing?.id || null)) {
        return log('That exact chat/agent target is already bound to another participant in this room.');
      }
      const name = protocol.cleanName(
        el.dexMemberName.value,
        existing?.name || source.providerName || 'Agent'
      );
      const relayEnabled = el.dexMemberRelayEnabled.checked;
      if (existing) {
        Object.assign(existing, rebindMember(existing, name, binding, relayEnabled));
        if (room.agentCheckpoints?.[existing.id]) Object.assign(room.agentCheckpoints[existing.id], { memberName: name, providerId: binding.providerId || null });
        log(`${name} participant binding updated without resetting room history.`);
      } else {
        room.members.push({ id: typeof uid === 'function' ? uid('agent') : stableMemberId(binding), name, binding, relayEnabled });
      }
      clear();
      persist();
      renderAll();
    }

    function render(room) {
      if (editingMemberId && !room?.members.some((member) => member.id === editingMemberId)) clear();
      renderMembers(room);
      renderBuilder();
      const blocked = mutationBlocked(room);
      el.dexAddMember.textContent = editingMemberId ? 'Save participant' : 'Add agent';
      el.dexAddMember.disabled = blocked;
      el.dexCancelMemberEdit.hidden = !editingMemberId;
      el.dexCancelMemberEdit.disabled = blocked;
    }

    el.dexMemberClass.addEventListener('change', () => renderBuilder({ targetClassId: el.dexMemberClass.value }));
    el.dexMemberType.addEventListener('change', () => renderBuilder({ typeId: el.dexMemberType.value }));
    el.dexAddMember.addEventListener('click', saveParticipant);
    el.dexCancelMemberEdit.addEventListener('click', () => { clear(); renderAll(); });

    return {
      render,
      renderBuilder,
      clear,
      isEditing: () => !!editingMemberId
    };
  }

  const api = {
    memberFingerprint,
    exactBinding, staleBinding, staleRoomCount,
    stableMemberId,
    bindingFromSource,
    memberTypeId,
    availableTargetId,
    hasBindingConflict,
    rebindMember,
    createController
  };
  globalThis.BrowserAiBridgeDexMembers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
