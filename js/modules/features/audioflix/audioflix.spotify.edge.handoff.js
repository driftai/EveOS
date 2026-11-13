window.EveAudioflixSpotifyEdgeHandoff = window.EveAudioflixSpotifyEdgeHandoff || {};
(function () {
  'use strict';
  const ns = window.EveAudioflixSpotifyEdgeHandoff;
  if (ns.ready) return;
  const native = () => window.EveAudioflixNative;

  async function releaseIdleManagedEngineBeforeEmbed() {
    const bridge = native();
    if (typeof bridge?.request !== 'function')
      throw new Error('Cannot verify the Spotify Engine owner before opening Official Embed.');
    const url = '/api/audioflix/spotify-browser';
    const read = async () => {
      const value = await bridge.request(`${url}/status`, { method: 'GET', timeout: 7000 });
      if (value?.ok !== true)
        throw new Error(value?.reason || 'Spotify Engine status is unavailable; refusing an unsafe output handoff.');
      return value;
    };
    const before = await read();
    if (before.browserRunning !== true) return;
    const capture = before.providerCapture || {};
    const transport = before.transport || {};
    const phase = String(transport.status || before.state || '').toLowerCase();
    const pausedDirectRoute = capture.active === true && capture.outputMode === 'direct'
      && capture.source === 'managed-spotify'
      && /^sd:\d+$/.test(String(capture.endpoint || ''));
    if (before.importing === true || Number(before.playingCount || 0) > 0
        || (capture.active === true && !pausedDirectRoute) || transport.paused === false
        || ['playing', 'controlling', 'starting', 'loading', 'buffering', 'resuming', 'importing'].includes(phase)) {
      throw new Error('Spotify Engine still reports active work. Stop its song/capture before switching to Official Embed.');
    }
    const stopped = await bridge.request(`${url}/stop`, {
      method: 'POST', timeout: 16000, body: '{}'
    });
    if (stopped?.ok !== true) throw new Error(stopped?.reason || 'The idle Spotify Engine refused to stop.');
    const after = await read();
    if (after.browserRunning === true || after.helperReachable === true)
      throw new Error('Spotify Engine shutdown was not confirmed; Official Embed was not started.');
  }

  Object.assign(ns, { ready: true, releaseIdleManagedEngineBeforeEmbed });
})();
