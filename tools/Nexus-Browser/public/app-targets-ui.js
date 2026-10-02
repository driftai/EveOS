(() => {
  function create({
    state,
    send,
    addMessage,
    log,
    renderBaseStatus = () => {}
  } = {}) {
    const el = {
      controls: document.querySelector('#appTargetControls'),
      type: document.querySelector('#appTypeSelect'),
      target: document.querySelector('#appTargetSelect'),
      refresh: document.querySelector('#refreshAppTargets'),
      connect: document.querySelector('#connectAppTarget'),
      status: document.querySelector('#appTargetStatus')
    };

    let types = [{ id: 'desktop-app', name: 'Desktop App' }];
    let selectedTypeId = 'desktop-app';
    let targets = [];
    let selectedTarget = null;
    let diagnostics = null;
    let targetStatus = null;
    let restorePending = false;
    let boundIdentity = null;

    function filteredTargets() {
      return targets.filter((target) => target.targetTypeId === selectedTypeId);
    }

    function renderTypes() {
      if (!el.type) return;
      const previous = el.type.value || selectedTypeId;
      el.type.replaceChildren();
      for (const type of types) el.type.add(new Option(type.name, type.id));
      selectedTypeId = types.some((type) => type.id === previous)
        ? previous
        : types[0]?.id || '';
      el.type.value = selectedTypeId;
    }

    function renderTargets() {
      if (!el.target) return;
      const previous = selectedTarget?.id || el.target.value;
      const visible = filteredTargets();
      el.target.replaceChildren();
      if (!visible.length) {
        el.target.add(new Option('No running app targets detected', ''));
        return;
      }
      for (const target of visible) {
        const suffix = target.pid ? ` · PID ${target.pid}` : '';
        const conversation = target.concreteTargetIdentity?.conversationTitle;
        const label = `${target.providerName || target.title}${conversation ? ` — ${conversation}` : ''}${suffix}`;
        el.target.add(new Option(label, target.id));
      }
      if (visible.some((target) => target.id === previous)) el.target.value = previous;
    }

    function helperHint() {
      const values = diagnostics && typeof diagnostics === 'object'
        ? Object.values(diagnostics).filter(Boolean)
        : [];
      const missing = values.find((entry) =>
        entry?.helper?.code === 'APP_BRIDGE_HELPER_MISSING'
        || entry?.lastError?.includes?.('winapp CLI')
        || entry?.code === 'APP_BRIDGE_HELPER_MISSING');
      if (missing) {
        return 'Windows app bridge helper missing · install with: winget install Microsoft.winappcli --source winget';
      }
      const lastError = values.map((entry) => entry?.lastError).find(Boolean);
      return lastError ? String(lastError) : '';
    }

    function renderStatusText() {
      if (!el.status) return;
      const hint = helperHint();
      if (selectedTarget) {
        const phase = targetStatus?.phase && targetStatus.phase !== 'idle'
          ? ` · ${targetStatus.phase}`
          : '';
        el.status.textContent = `Connected to ${selectedTarget.providerName || selectedTarget.title}${phase}.`;
      } else if (hint) {
        el.status.textContent = hint;
      } else {
        el.status.textContent = 'Open ChatGPT for Windows, then refresh and connect the detected app target.';
      }
    }

    function render() {
      if (!el.controls) return;
      const visible = state.selectedTargetClassId === 'app-origin';
      el.controls.hidden = !visible;
      if (!visible) return;
      renderTypes();
      renderTargets();
      const ready = state.uiConnectionPhase === 'connected';
      el.refresh.disabled = !ready;
      el.connect.disabled = !ready || !el.target.value;
      renderStatusText();
    }

    function handleMessage(msg = {}) {
      if (msg.type === 'app_targets_update') {
        types = Array.isArray(msg.types) && msg.types.length ? msg.types : types;
        targets = Array.isArray(msg.targets) ? msg.targets : [];
        diagnostics = msg.diagnostics || diagnostics;
        if (msg.target) {
          selectedTarget = msg.target;
          restorePending = false;
        } else if ('target' in msg && !msg.refreshing && selectedTarget) {
          const candidate = targets.find((target) => target.id === selectedTarget.id);
          if (candidate && state.uiConnectionPhase === 'connected' && !restorePending) {
            restorePending = true;
            send({ type: 'select_app_target', targetId: candidate.id,
              expectedIdentity: boundIdentity || selectedTarget.concreteTargetIdentity || null });
          } else if (!candidate) {
            selectedTarget = null;
            targetStatus = null;
            boundIdentity = null;
            restorePending = false;
          }
        }
        render();
        renderBaseStatus();
        log(`Detected ${targets.length} App-Origin target(s).`);
        return true;
      }
      if (msg.type === 'app_target_selected') {
        const restoring = restorePending;
        restorePending = false;
        selectedTarget = msg.target || null;
        if (msg.bindingIdentity) boundIdentity = { ...msg.bindingIdentity };
        else if (!restoring) boundIdentity = selectedTarget?.concreteTargetIdentity
          ? { ...selectedTarget.concreteTargetIdentity } : null;
        targetStatus = msg.status || null;
        diagnostics = msg.diagnostics || diagnostics;
        render();
        renderBaseStatus();
        addMessage('system', selectedTarget
          ? `Connected to app target ${selectedTarget.providerName || selectedTarget.title}.`
          : 'App target selection cleared.');
        return true;
      }
      if (msg.type === 'app_target_status') {
        if (!selectedTarget || !msg.targetId || selectedTarget.id === msg.targetId) {
          targetStatus = msg.status || null;
          diagnostics = msg.diagnostics || diagnostics;
          if (msg.bindingIdentity) boundIdentity = { ...msg.bindingIdentity };
          renderStatusText();
          renderBaseStatus();
        }
        return true;
      }
      if (msg.type === 'app_target_binding_update') {
        if (selectedTarget?.id === msg.targetId && msg.bindingIdentity) {
          boundIdentity = { ...msg.bindingIdentity };
        }
        return true;
      }
      if (msg.type === 'native_app_turn') {
        const id = msg.fingerprint ? `native-app-${msg.fingerprint}` : null;
        addMessage('assistant', msg.text || '', id, false,
          msg.providerName || selectedTarget?.providerName || 'ChatGPT App');
        send({ type: 'ack_native_app_turn', targetId: msg.targetId, fingerprint: msg.fingerprint });
        log(`Observed passive ${msg.providerName || 'App-Origin'} native turn (${(msg.text || '').length} chars).`);
        return true;
      }
      if (msg.type === 'app_target_rebind_required') {
        restorePending = false;
        if (!selectedTarget || !msg.targetId || selectedTarget.id === msg.targetId) {
          selectedTarget = null;
          targetStatus = null;
          boundIdentity = null;
        }
        render();
        renderBaseStatus();
        addMessage('system', msg.message || 'Native app conversation changed; reconnect the App-Origin target.');
        log('App-Origin rebind required.');
        return true;
      }
      return false;
    }

    function requestTargets(force = false) {
      return send({ type: 'request_app_targets', force });
    }

    el.type?.addEventListener('change', () => {
      selectedTypeId = el.type.value;
      renderTargets();
      render();
    });
    el.refresh?.addEventListener('click', () => requestTargets(true));
    el.connect?.addEventListener('click', () => {
      const targetId = el.target.value;
      if (!targetId) return addMessage('system', 'Choose a running app target first.');
      restorePending = false;
      boundIdentity = null;
      send({ type: 'select_app_target', targetId });
    });

    return {
      render,
      handleMessage,
      requestTargets,
      target: () => selectedTarget,
      status: () => targetStatus,
      bindingIdentity: () => boundIdentity ? { ...boundIdentity } : null,
      diagnostics: () => diagnostics,
      targets: () => targets.map((target) => ({ ...target }))
    };
  }

  const api = { create };
  globalThis.BrowserAiBridgeAppTargetsUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
