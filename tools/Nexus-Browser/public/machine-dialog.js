(() => {
  'use strict';

  const fileActions = [
    'files_grants', 'files_status', 'files_list', 'files_tree', 'files_stat', 'files_read', 'files_search',
    'files_create', 'files_write', 'files_patch', 'files_move', 'files_delete'
  ];
  const mutatingFileActions = ['files_create', 'files_write', 'files_patch', 'files_move', 'files_delete'];
  for (const action of fileActions) {
    globalThis.BrowserAiBridgeDexProtocol?.PROVIDER_CONTROL_ACTIONS?.add?.(action);
    globalThis.BrowserAiBridgeDexProviderControl?.ACTIONS?.add?.(action);
  }
  for (const action of mutatingFileActions) globalThis.BrowserAiBridgeDexProviderControl?.MUTATING_ACTIONS?.add?.(action);
  globalThis.BrowserAiBridgeMachineFileActions = Object.freeze({
    ACTIONS: new Set(fileActions),
    MUTATING_ACTIONS: new Set(mutatingFileActions)
  });

  // In-page replacement for window.confirm/prompt. EveOS embeds Nexus in a
  // sandboxed iframe without allow-modals, where native dialogs silently return
  // null/false, so every Machine Spaces decision uses this DOM dialog instead.
  if (globalThis.BrowserAiBridgeMachineDialog) return;
  let open = null;

  function build({ title, body = '', input = null, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
    const overlay = document.createElement('div');
    overlay.className = 'machine-dialog-overlay';
    const box = document.createElement('div');
    box.className = 'machine-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = title;
    box.append(heading);
    if (body) {
      const text = document.createElement('pre');
      text.className = 'machine-dialog-body';
      text.textContent = body;
      box.append(text);
    }
    let field = null;
    if (input) {
      field = document.createElement('input');
      field.type = 'text';
      field.className = 'machine-dialog-input';
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
      field.maxLength = input.maxLength || 120;
      field.spellcheck = false;
      field.autocomplete = 'off';
      box.append(field);
    }
    const actions = document.createElement('div');
    actions.className = 'machine-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = cancelText;
    const ok = document.createElement('button');
    ok.type = 'button'; ok.textContent = confirmText;
    if (danger) ok.classList.add('danger');
    actions.append(cancel, ok);
    box.append(actions);
    overlay.append(box);
    return { overlay, field, ok, cancel };
  }

  function show(options) {
    if (open) open.finish(null);
    return new Promise((resolve) => {
      const parts = build(options);
      const finish = (value) => {
        if (!open || open.parts !== parts) return;
        open = null;
        parts.overlay.remove();
        resolve(value);
      };
      open = { parts, finish };
      const accept = () => finish(parts.field ? parts.field.value : true);
      parts.ok.addEventListener('click', accept);
      parts.cancel.addEventListener('click', () => finish(null));
      parts.overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); finish(null); }
        if (event.key === 'Enter' && parts.field && event.target === parts.field) { event.preventDefault(); accept(); }
      });
      document.body.append(parts.overlay);
      (parts.field || parts.cancel).focus();
    });
  }

  const api = {
    confirm: async (title, body = '', extra = {}) => (await show({ title, body, ...extra })) === true,
    prompt: (title, value = '', extra = {}) => show({ title, body: extra.body || '', input: { value, placeholder: extra.placeholder },
      confirmText: extra.confirmText || 'OK', danger: extra.danger }),
    isOpen: () => !!open
  };
  globalThis.BrowserAiBridgeMachineDialog = api;
})();
