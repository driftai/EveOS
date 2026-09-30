let peer = null, lastMetadata = {};
const linked = () => Boolean(peer && !peer.closed);
const notifySharing = () => chrome.runtime.sendMessage({ to:'popup', type:'capture-state', linked:linked() }).catch(() => {});

function stop() {
  peer?.stop();
  peer = null;
  lastMetadata = {};
  void notifySharing();
}

function sourceEnded(status) {
  chrome.runtime.sendMessage({ to:'worker', type:'source-ended', status }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  (async () => {
    if (message.type === 'stop') { stop(); return { ok:true }; }
    if (message.type === 'status') return {
      linked: linked(),
      relayVideoMode: 'state-only',
      captureSettings: null,
      diagnostics: []
    };
    if (message.type === 'sample') {
      lastMetadata = message.metadata || {};
      peer?.metadata(lastMetadata);
      return { ok:true, relayVideoMode:'state-only' };
    }
    if (message.type !== 'start') return { ok:false };
    stop();
    lastMetadata = message.initialMetadata || {};
    peer = new WatchFusionLivePeer({
      base: message.base,
      id: message.id,
      token: message.token,
      publisher: true,
      onReady: () => peer?.metadata(lastMetadata),
      onControl: (action, value) => chrome.runtime.sendMessage({ to:'worker', type:'control', action, value }).catch(() => {}),
      onStatus: status => {
        if (/stopped|expired|denied|replaced/i.test(String(status || ''))) sourceEnded(status);
      }
    });
    void notifySharing();
    return { ok:true, relayVideoMode:'state-only' };
  })().then(reply, error => reply({ error:error.message }));
  return true;
});
