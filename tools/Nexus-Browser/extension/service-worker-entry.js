if (typeof importScripts === 'function') {
  importScripts('extension-assets.js');
  importScripts('runtime-config.js');
  importScripts('dashboard-open.js');
  importScripts('eveos-hub-connector.js');
  importScripts('dex-ui-refresh.js');
  importScripts('content/provider-adapter-revision.js');
  importScripts('provider-adapter-freshness.js');
  importScripts('provider-target-list.js');
  importScripts('provider-target-spawn.js');
  importScripts('chatgpt-app-mirror.js');
  importScripts('chatgpt-app-mirror-dedupe.js');
  importScripts('chatgpt-app-mirror-worker.js');
  importScripts('task-completion-bridge.js');
  importScripts('dex-bound-tab-watchdog.js');
  importScripts('dex-tool-result.js');
  importScripts('dex-provider-control-bridge.js');
  importScripts('chatgpt-stream-nudge-bridge.js');
  importScripts('dex-final-receipt.js');
  importScripts('dex-final-delivery-wiring.js');
  importScripts('request-ownership.js');
  importScripts('provider-return-routing.js');
  importScripts('host-access.js');
  importScripts('target-state.js');
  importScripts('target-resurrection.js');
  importScripts('qualification-warm-target.js');
  importScripts('qualification-control.js');
  importScripts('adapter-readiness-cache.js');
  importScripts('dex-ui-ensure.js');
  importScripts('dex-provider-control-boot.js');
  importScripts('chatgpt-navigation-recovery.js');
  importScripts('background-dispatch.js');
  importScripts('tab-readiness.js');
  importScripts('service-worker.js');
  // service-worker.js loads the canonical provider registry first. Mutating that same PROVIDERS
  // array after boot lets Hark participate in the existing target loader/routing closures without
  // forcing a rewrite of the six qualified provider definitions.
  importScripts('hark-provider.js');
}
