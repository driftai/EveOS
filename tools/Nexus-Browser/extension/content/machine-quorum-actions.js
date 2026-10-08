(() => {
  'use strict';
  const actions = ['quorum_presence', 'quorum_open', 'quorum_vote', 'quorum_status', 'quorum_close'];
  const control = globalThis.BrowserAiBridgeDexProviderControlContent;
  for (const action of actions) control?.ACTIONS?.add?.(action);
  globalThis.BrowserAiBridgeMachineQuorumContentActions = Object.freeze({ ACTIONS: new Set(actions) });
})();
