(() => {
  'use strict';
  const actions = ['job_prepare', 'job_status', 'job_list'];
  const control = globalThis.BrowserAiBridgeDexProviderControlContent;
  for (const action of actions) control?.ACTIONS?.add?.(action);
  globalThis.BrowserAiBridgeMachineJobContentActions = Object.freeze({ ACTIONS: new Set(actions) });
})();
