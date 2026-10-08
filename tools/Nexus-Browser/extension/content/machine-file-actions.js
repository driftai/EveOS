(() => {
  'use strict';
  const actions = [
    'files_grants', 'files_status', 'files_list', 'files_tree', 'files_stat', 'files_read', 'files_search',
    'files_create', 'files_write', 'files_patch', 'files_move', 'files_delete'
  ];
  const control = globalThis.BrowserAiBridgeDexProviderControlContent;
  for (const action of actions) control?.ACTIONS?.add?.(action);
  globalThis.BrowserAiBridgeMachineFileContentActions = Object.freeze({ ACTIONS: new Set(actions) });
})();
