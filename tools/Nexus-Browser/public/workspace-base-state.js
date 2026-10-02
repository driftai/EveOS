(() => {
  function messageSnapshot(transcript, maxMessages = 80) {
    return [...(transcript?.querySelectorAll?.('article.message') || [])].slice(-maxMessages).map((node) => ({
      role: node.classList.contains('user') ? 'user' : node.classList.contains('assistant') ? 'assistant' : 'system',
      id: node.dataset.messageId || null,
      partial: node.classList.contains('partial'),
      label: node.querySelector('.message-label')?.textContent || '',
      text: node.querySelector('.message-body')?.textContent || ''
    }));
  }

  function restoreMessages(transcript, messages = []) {
    transcript?.replaceChildren?.();
    for (const message of Array.isArray(messages) ? messages : []) {
      const node = document.createElement('article');
      node.className = `message ${message.role || 'system'}`;
      if (message.partial) node.classList.add('partial');
      if (message.id) node.dataset.messageId = message.id;
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = message.label || (message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'System');
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = message.text || '';
      node.append(label, body);
      transcript?.append?.(node);
    }
  }

  function create({
    state, el, render = () => {}, send = () => false,
    appTarget = () => null, appBindingIdentity = () => null,
    connect = () => {}, disconnect = () => {}
  } = {}) {
    let restoredAppTarget = null, restoredAppBinding = null;

    function snapshot() {
      return {
        version: 1,
        selectedTargetClassId: state.selectedTargetClassId,
        selectedProviderId: state.selectedProviderId,
        selectedLocalTypeId: state.selectedLocalTypeId,
        onlineTarget: state.onlineTarget || null,
        localTarget: state.localTarget || null,
        appTarget: appTarget() || null,
        appBindingIdentity: appBindingIdentity() || null,
        prompt: el.prompt?.value || '',
        transcript: messageSnapshot(el.transcript),
        transcriptScrollTop: Number(el.transcript?.scrollTop || 0)
      };
    }

    function restore(value = {}) {
      if (typeof value.selectedTargetClassId === 'string') state.selectedTargetClassId = value.selectedTargetClassId;
      if (typeof value.selectedProviderId === 'string') state.selectedProviderId = value.selectedProviderId;
      if (typeof value.selectedLocalTypeId === 'string') state.selectedLocalTypeId = value.selectedLocalTypeId;
      state.onlineTarget = value.onlineTarget || null;
      state.localTarget = value.localTarget || null;
      restoredAppTarget = value.appTarget || null;
      restoredAppBinding = value.appBindingIdentity || restoredAppTarget?.concreteTargetIdentity || null;
      if (typeof value.prompt === 'string' && el.prompt) el.prompt.value = value.prompt;
      restoreMessages(el.transcript, value.transcript);
      render();
      if (Number.isFinite(Number(value.transcriptScrollTop))) {
        requestAnimationFrame(() => { if (el.transcript) el.transcript.scrollTop = Number(value.transcriptScrollTop); });
      }
    }

    function onOpen() {
      if (state.selectedTargetClassId === 'online-origin' && state.onlineTarget?.id != null) {
        send({ type: 'select_target', tabId: Number(state.onlineTarget.id), providerId: state.onlineTarget.providerId });
      } else if (state.selectedTargetClassId === 'local-origin' && state.localTarget?.id) {
        send({ type: 'select_local_target', targetId: state.localTarget.id,
          targetTypeId: state.selectedLocalTypeId || state.localTarget.targetTypeId });
      } else if (state.selectedTargetClassId === 'app-origin' && restoredAppTarget?.id) {
        send({ type: 'select_app_target', targetId: restoredAppTarget.id, expectedIdentity: restoredAppBinding || null });
      }
    }

    return { snapshot, restore, onOpen, resume: connect, suspend: disconnect };
  }

  const api = { create, messageSnapshot, restoreMessages };
  globalThis.BrowserAiBridgeBaseWorkspace = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
