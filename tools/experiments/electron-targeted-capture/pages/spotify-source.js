'use strict';
// Official Spotify IFrame API controller. It owns provider transport only; EveOS owns queue order.
const bridge = window.eveSpotifyDirect;
const statusEl = document.getElementById('status');
let iframeApi = null, controller = null, current = null, generation = 0, lastEndedGeneration = -1;
let last = { status: 'loading', currentTime: 0, duration: 0, paused: true };

function emit(type, detail = {}) { bridge.event({ type, ...detail }); }
function update(next) {
  last = { ...last, ...next };
  statusEl.textContent = `${last.status} · ${Math.round(last.currentTime || 0)} / ${Math.round(last.duration || 0)} sec`;
  emit('state', { ...last, identity: current, generation });
}
function reply(id, ok, detail = {}) {
  const result = { id: String(id || ''), ok, ...detail };
  emit('reply', result);
  return result;
}
function playbackUpdate(event) {
  const data = event?.data || event || {}, position = Math.max(0, Number(data.position || 0) / 1000);
  const duration = Math.max(0, Number(data.duration || 0) / 1000);
  const paused = data.isPaused !== false;
  const atEnd = duration > 0 && position >= Math.max(0, duration - 0.35);
  if (atEnd && (last.status === 'playing' || lastEndedGeneration === generation)) {
    const completionId = lastEndedGeneration === generation ? last.completionId : `${generation}:${Date.now()}`;
    lastEndedGeneration = generation;
    update({ status: 'ended', currentTime: duration, duration, paused: true, completionId });
  } else update({ status: paused ? (last.status === 'stopped' ? 'stopped' : 'paused') : 'playing',
    currentTime: position, duration, paused });
}

async function command(value = {}) {
  const id = value.id, action = String(value.action || ''), payload = value.payload || {};
  emit('diagnostic', { stage: 'command', action });
  try {
    if (action === 'load') {
      const uri = String(payload.spotifyUri || '');
      if (!/^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(uri)) throw new Error('Invalid Spotify media identity.');
      if (!iframeApi) throw new Error('Spotify IFrame API is not ready.');
      generation += 1; lastEndedGeneration = -1;
      current = { spotifyUri: uri, spotifyId: uri.split(':')[2], mediaType: uri.split(':')[1],
        itemId: String(payload.itemId || ''), title: String(payload.title || '') };
      update({ status: 'loading', currentTime: 0, duration: Math.max(0, Number(payload.duration || 0)), paused: true,
        completionId: '' });
      if (!controller) {
        emit('diagnostic', { stage: 'create-controller', action, uri });
        controller = await new Promise((resolve) => iframeApi.createController(
          document.getElementById('embed-iframe'), { uri, width: '100%', height: 152 }, (next) => {
            next.addListener('ready', () => update({ status: 'ready', paused: true }));
            next.addListener('playback_started', () => update({ status: 'playing', paused: false }));
            next.addListener('playback_update', playbackUpdate);
            emit('controller-created');
            emit('diagnostic', { stage: 'controller-created', action, uri });
            resolve(next);
          }));
      } else controller.loadUri(uri);
    } else if (!controller) {
      throw new Error('Spotify IFrame controller is not ready.');
    } else if (action === 'play') controller.play();
    else if (action === 'pause') { controller.pause(); update({ status: 'paused', paused: true }); }
    else if (action === 'resume') controller.resume();
    else if (action === 'seek') controller.seek(Math.max(0, Number(payload.seconds || 0)));
    else if (action === 'stop') {
      controller.pause(); controller.seek(0); update({ status: 'stopped', currentTime: 0, paused: true });
    } else if (action === 'status') return reply(id, true, { state: last, identity: current, generation });
    else throw new Error('Unsupported Spotify Direct command.');
    return reply(id, true, { state: last, identity: current, generation });
  } catch (error) {
    emit('diagnostic', { stage: 'command-error', action, reason: String(error?.message || error).slice(0, 180) });
    return reply(id, false, { reason: String(error?.message || error) });
  }
}

bridge.onCommand((value) => { command(value); });
window.__eveSpotifyCommand = command;
emit('shell-ready');
window.onSpotifyIframeApiReady = (IFrameAPI) => {
  iframeApi = IFrameAPI;
  emit('diagnostic', { stage: 'sdk-ready' });
  update({ status: 'sdk-ready', paused: true });
  emit('ready');
};
