// Official Spotify Embed policy: licensed Edge Beta app window + Windows process audio endpoint.
// This is distinct from the managed Spotify Engine and the deferred Electron host.
window.EveAudioflixSpotifyEdge = window.EveAudioflixSpotifyEdge || {};
(function () {
  'use strict';
  const ns = window.EveAudioflixSpotifyEdge;
  if (ns.ready) return;
  const media = () => window.EveAudioflixSpotifyMedia;
  const native = () => window.EveAudioflixNative;
  const policyOf = item => window.EveAudioflixPlaybackPolicy?.resolve?.(item) || {};
  const spotify = item => media()?.fromItem?.(item);
  const gain = value => window.EveAudioflixSpotifyVolume?.effectiveGain?.(value)
    ?? Math.max(0, Math.min(1, Number(value) || 0));
  let installed = false, active = false, starting = false, item = null;
  let epoch = 0, pollTimer = 0, lastState = '', lastRoute = false;
  let lastEndedRevision = -1, windowToggle = null, windowHidden = false;
  let edgePanel = null, edgePanelExpanded = false;
  let playback = { item: null, paused: true, currentTime: 0, duration: 0,
    provider: 'spotify', browserOnly: true, edgeEmbed: true };
  const fire = (event, detail) => window.dispatchEvent(new CustomEvent(event, { detail }));
  const progress = () => fire('eve:audioflix-progress', { ...playback });
  function notify(status, error = false, detail = {}) {
    fire('eve:audioflix-playback', { status, item, provider: 'spotify', browserOnly: true,
      edgeEmbed: true, error, ...detail });
  }
  async function request(action, payload = {}, timeout = 15000) {
    if (!native()?.request) throw new Error('EveOS local bridge is unavailable. Open EveOS through localhost.');
    const result = await native().request('/api/audioflix/spotify-edge/command', {
      method: 'POST', timeout, body: JSON.stringify({ action, payload })
    });
    if (!result?.ok) throw new Error(result?.reason || result?.message || 'Spotify Edge Beta transport failed.');
    return result;
  }
  // Engine Stop only retires a song/relay lease. The persistent Edge Beta profile
  // remains live until its helper is explicitly stopped. Official Embed must not
  // start beside that owner because Windows per-app routing is shared.
  async function releaseIdleManagedEngineBeforeEmbed() {
    const bridge = native();
    if (typeof bridge?.request !== 'function')
      throw new Error('Cannot verify the Spotify Engine owner before opening Official Embed.');
    const url = '/api/audioflix/spotify-browser';
    const read = async () => {
      const value = await bridge.request(`${url}/status`, { method: 'GET', timeout: 7000 });
      if (value?.ok !== true) throw new Error(value?.reason || 'Spotify Engine status is unavailable; refusing an unsafe output handoff.');
      return value;
    };
    const before = await read();
    if (before.browserRunning !== true) return;
    const capture = before.providerCapture || {};
    const transport = before.transport || {};
    const phase = String(transport.status || before.state || '').toLowerCase();
    // Direct mode reports the *Windows routing worker* as providerCapture.active.
    // This is NOT authorized tab capture. A paused, exact-owned direct route may
    // be released by the verified managed-Engine stop before Official Embed starts.
    // Unknown/ambiguous active routes and real tab capture remain fail-closed.
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

  // White is an approved monochrome Spotify mark on this dark control.
  // The orange housing belongs to EveOS; the official logo is never recolored.
  const SPOTIFY_ICON = 'https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Primary_Logo_RGB_White.png';
  function updateWindowToggle() {
    if (!windowToggle) return;
    windowToggle.disabled = !active;
    windowToggle.title = windowHidden ? 'Show the Spotify Edge Beta player' : 'Hide the Spotify Edge Beta player';
    windowToggle.setAttribute('aria-label', windowToggle.title);
    windowToggle.textContent = windowHidden ? 'Show Spotify' : 'Hide Spotify';
  }
  function mountWindowToggle() {
    // The dedicated Edge player can be controlled from Internal Player only;
    // no floating button obscures AudioFlix's library, game, or Nexus surfaces.
    if (!edgePanelExpanded || !edgePanel || typeof document === 'undefined') return;
    const stage = edgePanel.getStage?.();
    const controls = stage?.querySelector?.('header > div:last-child');
    if (!controls) return;
    if (windowToggle && controls.contains?.(windowToggle)) { updateWindowToggle(); return; }
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.edgeWindowToggle = 'true';
    button.style.cssText = 'border:1px solid #b78645;border-radius:16px;background:#59391f;color:#fff;padding:5px 10px;cursor:pointer';
    button.addEventListener('click', () => {
      if (!active || button.disabled) return;
      const action = windowHidden ? 'show' : 'hide';
      button.disabled = true;
      request(action, {}, 8000).then(() => {
        windowHidden = action === 'hide'; updateWindowToggle();
        notify(action === 'show' ? 'Spotify Edge Beta window shown.' : 'Spotify Edge Beta window hidden.');
      }).catch(error => notify(`Spotify window control: ${error.message}`, true))
        .finally(updateWindowToggle);
    });
    controls.prepend(button); windowToggle = button; updateWindowToggle();
  }
  function mountQueueControls() {
    if (!edgePanelExpanded || !edgePanel || typeof document === 'undefined') return;
    const stage = edgePanel.getStage?.();
    const tools = stage?.querySelector?.('.audioflix-provider-tools');
    if (!tools) return;
    for (const [action, title] of [['shuffle-music-group', 'Shuffle order'],
                                    ['loop-music-group', 'Loop group']]) {
      if (tools.querySelector?.(`[data-edge-queue-action="${action}"]`)) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.edgeQueueAction = action;
      button.textContent = title;
      button.addEventListener('click', () => {
        window.EveAudioflix?.queueConnection?.action?.(action);
        syncEdgePanel();
      });
      tools.append(button);
    }
  }
  // The existing AudioFlix transport view is presentation, not another Spotify
  // iframe. Keep the single Edge host as the sole provider and audio output.
  function panelController(audio) {
    if (edgePanel) return edgePanel;
    const factory = window.EveAudioflixInternalPlayer?.createController;
    if (typeof factory !== 'function') throw new Error('The EveOS Internal Player is unavailable. Reload EveOS.');
    edgePanel = factory({
      onClose: () => closeEdgePanel(),
      onToggle: () => (playback.paused ? audio.resume() : audio.pause()),
      onStep: delta => window.EveAudioflix?.queueConnection?.step?.(delta),
      onJump: index => window.EveAudioflix?.queueConnection?.jump?.(index),
      onSeek: seconds => audio.seek(seconds),
      getVolumeItem: () => item,
      onVolume: (level, options = {}) => {
        if (!item) return;
        const bounded = Math.max(0, Math.min(1, Number(level) || 0));
        if (options.persist !== false && item.id != null)
          window.EveAudioflixState?.setItemVolume?.(item.type || 'music', item.id, bounded);
        audio.updateItemVolume(item.id, bounded, options);
      },
      // The official Spotify embed does not expose a reliable rate setting.
      onRate: () => edgePanel?.setStatus?.('Spotify controls playback speed in its own player.')
    });
    return edgePanel;
  }
  function syncEdgePanel() {
    if (!edgePanelExpanded || !edgePanel || !active) return;
    edgePanel.sync?.({ ...playback });
    const queue = window.EveAudioflix?.queueConnection?.snapshot?.();
    edgePanel.setQueue?.(queue?.entries || [], queue?.currentIndex ?? 0);
    const stage = edgePanel.getStage?.();
    // Keep the same controls as the managed Spotify queue, even if the user
    // opens the panel before starting Play Group. Disable unavailable actions.
    for (const [offset, selector] of [[-1, '[data-url-player-action="prev"]'],
                                      [1, '[data-url-player-action="next"]']]) {
      const button = stage?.querySelector?.(selector);
      if (!button) continue;
      button.hidden = false;
      button.disabled = !queue?.entries?.length || (offset < 0
        ? queue.currentIndex <= 0 : queue.currentIndex >= queue.entries.length - 1);
    }
    const tools = stage?.querySelector?.('.audioflix-provider-tools');
    if (tools) tools.hidden = false;
    const usable = Array.isArray(queue?.entries) && queue.entries.length > 0;
    for (const action of ['shuffle-music-group', 'loop-music-group']) {
      const button = stage?.querySelector?.(`[data-edge-queue-action="${action}"]`);
      if (!button) continue;
      button.disabled = !usable;
      const on = action === 'shuffle-music-group' ? queue?.shuffle === true : queue?.loop === true;
      button.setAttribute?.('aria-pressed', String(on));
      button.textContent = (action === 'shuffle-music-group' ? 'Shuffle order' : 'Loop group') + (on ? ' on' : '');
    }
  }
  function showEdgePanel(audio) {
    if (!active || !item) return false;
    const view = panelController(audio);
    const frame = view.open(item, 'Spotify', { expanded: true, visible: true });
    // Never embed Spotify a second time in the EveOS UI: the native Edge app
    // window retains session, output, queue ownership, and authorization.
    frame?.replaceChildren?.();
    view.setVisualVisible?.(false);
    view.setStatus?.('Spotify plays through the dedicated Edge window and your selected CABLE output.');
    const rate = view.getStage?.()?.querySelector?.('.audioflix-provider-rate');
    if (rate) { rate.disabled = true; rate.title = 'Playback speed is controlled by Spotify'; }
    edgePanelExpanded = true;
    mountWindowToggle(); mountQueueControls();
    syncEdgePanel();
    return true;
  }
  function closeEdgePanel() {
    edgePanelExpanded = false;
    edgePanel?.hide?.();
    return true;
  }
  function update(status) {
    const state = status?.state || {};
    if (status?.identity && spotify(item)?.spotifyUri !== status.identity) return;
    windowHidden = status?.windowHidden === true;
    if (active) updateWindowToggle();
    playback.currentTime = Math.max(0, Number(state.currentTime || 0));
    playback.duration = Math.max(0, Number(state.duration || playback.duration || item?.duration || 0));
    playback.paused = state.paused !== false;
    const key = `${status.status}/${playback.paused ? 'paused' : 'playing'}`;
    if (key !== lastState) {
      lastState = key;
      if (status.status === 'route-error') notify(status.message || 'CABLE output could not be assigned.', true);
      else if (status.status === 'route-pending') notify(status.message || 'Waiting for Spotify audio on CABLE.');
      else if (playback.paused === false) notify(`Playing ${item?.title || 'Spotify track'} through Edge`);
      else notify(status.message || 'Spotify card is ready; automatic Play will be attempted.');
    }
    if (status.routeConfirmed && !lastRoute) {
      lastRoute = true;
      notify(`Spotify Edge Beta audio routed to ${status.deviceName || 'selected output'}`);
    }
    progress();
    syncEdgePanel();
    if (state.ended === true && status.endedRevision === status.mediaRevision
        && Number.isSafeInteger(status.endedRevision) && status.endedRevision >= 0
        && lastEndedRevision !== status.endedRevision && !starting) {
      lastEndedRevision = status.endedRevision;
      // Existing EveOS QueueCompletion consumes only this exact item+run.
      notify('Ended');
    }
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = 0; }
  async function poll() {
    const observed = epoch;
    try {
      const result = await native()?.request?.('/api/audioflix/spotify-edge/status',
        { method: 'GET', timeout: 2500 });
      if (!active || starting || observed !== epoch) return;
      if (!result?.running) {
        stopPolling(); active = false;
        notify('Spotify Edge Beta window stopped. Play again to reopen it.', true);
      } else update(result);
    } catch { /* Preserve a running provider during a transient server status failure. */ }
  }
  async function stopEdge() {
    if (!active && !starting) return;
    ++epoch;
    stopPolling();
    try { await request('stop', {}, 9000); }
    catch (error) {
      notify(`Spotify Edge Beta stop needs attention: ${error.message}`, true);
      active = true; // fail closed; do not open a second provider over the first
      throw error;
    }
    closeEdgePanel();
    active = false; starting = false; item = null;
    lastRoute = false; lastState = '';
    playback = { item: null, paused: true, currentTime: 0, duration: 0,
      provider: 'spotify', browserOnly: true, edgeEmbed: true };
    if (windowToggle) windowToggle.disabled = true;
    windowHidden = false; lastEndedRevision = -1;
  }
  async function playEdge(nextItem, original, resolvedPolicy) {
    const identity = spotify(nextItem);
    if (!identity) return original.playItem(nextItem);
    const current = ++epoch;
    // A second Play during an in-flight first Play is still a switch intent.
    // Never call global stopAll merely because the first startup is pending.
    const reuse = active;
    starting = true;
    if (!reuse) await original.stopAll();
    if (current !== epoch) return false;
    const selected = resolvedPolicy || policyOf(nextItem);
    if (selected.outputMode === 'custom' && selected.outputKind === 'browser') {
      starting = false;
      throw new Error('Official Spotify Embed requires a native output port.');
    }
    const deviceId = selected.outputKind === 'native' && /^sd:\d+$/.test(String(selected.outputId || ''))
      ? selected.outputId : '';
    try {
      if (!reuse) {
        await releaseIdleManagedEngineBeforeEmbed();
        if (current !== epoch) return false;
      }
      // The same owned Edge app window and native CABLE route are retained.
      // Distinct queue entries with an identical Spotify URL still get new revisions.
      const result = await request(reuse ? 'switch' : 'play', {
        ...identity, deviceId, gain: gain(nextItem.volume ?? 1)
      }, 25000);
      if (current !== epoch) return false;
      if (!result.running) throw new Error('Spotify Edge Beta host is not running.');
      active = true; item = nextItem; lastEndedRevision = -1;
      playback = { item, currentTime: 0, duration: Number(item.duration || 0), paused: true,
        provider: 'spotify', browserOnly: true, edgeEmbed: true };
      lastState = ''; windowHidden = result.windowHidden === true;
      updateWindowToggle();
      if (edgePanelExpanded) {
        const frame = edgePanel?.open?.(item, 'Spotify', { expanded: true, visible: true });
        frame?.replaceChildren?.();
        edgePanel?.setVisualVisible?.(false);
        edgePanel?.setStatus?.('Playing through the existing Spotify Edge Beta window.');
        mountWindowToggle(); mountQueueControls();
        syncEdgePanel();
      }
      notify(reuse ? 'Updating song in the existing Spotify Edge Beta window.'
        : 'Opening official Spotify card in Edge; attempting Play.');
      update(result);
      stopPolling(); pollTimer = setInterval(poll, 1000);
      window.EveAudioflixState?.recordPlay?.(nextItem);
      return true;
    } catch (error) {
      if (current === epoch) {
        // Keep ownership of an already running host on failed switch: the old
        // song may still be audible; never launch a duplicate or auto-skip it.
        if (!reuse) active = false;
        notify(`Official Spotify Embed failed: ${error.message}`, true);
      }
      throw error;
    } finally { if (current === epoch) starting = false; }
  }
  function install() {
    if (installed || !window.EveAudioflixAudio?.ready || !media()?.ready || !native()?.ready) return false;
    installed = true;
    const audio = window.EveAudioflixAudio;
    const original = {
      playItem: audio.playItem.bind(audio),
      layerPlay: typeof audio.layerPlay === 'function' ? audio.layerPlay.bind(audio) : null,
      openInternalView: audio.openInternalView.bind(audio),
      pause: audio.pause.bind(audio), resume: audio.resume.bind(audio),
      seek: audio.seek.bind(audio), stopAll: audio.stopAll.bind(audio),
      stopItemLayers: audio.stopItemLayers.bind(audio),
      updateItemVolume: audio.updateItemVolume.bind(audio),
      getPlaybackState: audio.getPlaybackState.bind(audio),
      getStatus: audio.getStatus?.bind(audio)
    };
    const originalView = {
      isOpen: audio.isInternalViewOpen?.bind(audio),
      hide: audio.hideInternalView?.bind(audio),
      close: audio.closeInternalView?.bind(audio),
      syncQueue: audio.syncQueueView?.bind(audio)
    };
    audio.isInternalViewOpen = () => (active && edgePanelExpanded) || originalView.isOpen?.() === true;
    audio.hideInternalView = () => active && edgePanelExpanded ? closeEdgePanel() : originalView.hide?.();
    audio.closeInternalView = () => active && edgePanelExpanded ? closeEdgePanel() : originalView.close?.();
    audio.syncQueueView = (...args) => {
      const result = originalView.syncQueue?.(...args);
      syncEdgePanel();
      return result;
    };
    audio.playItem = async function edgePlay(nextItem) {
      if (policyOf(nextItem).spotifyMethod !== 'embed' || !spotify(nextItem)) {
        if (active || starting) await stopEdge();
        return original.playItem(nextItem);
      }
      return playEdge(nextItem, original, policyOf(nextItem));
    };
    if (original.layerPlay) audio.layerPlay = async function edgeLayer(nextItem) {
      if (policyOf(nextItem).spotifyMethod !== 'embed' || !spotify(nextItem))
        return original.layerPlay(nextItem);
      // Explicit Spotify mode owns one browser host. Layer cards must not silently
      // construct an in-page iframe beside it.
      try { return await audio.playItem(nextItem); }
      catch (error) { notify(`Official Spotify Embed: ${error.message}`, true, { terminal: true }); return false; }
    };
    audio.openInternalView = async function edgeInternal(nextItem) {
      if (policyOf(nextItem).spotifyMethod !== 'embed' || !spotify(nextItem)) {
        if (active || starting) await stopEdge();
        return original.openInternalView(nextItem);
      }
      const selectedId = String(item?.id ?? '');
      const incomingId = String(nextItem?.id ?? '');
      const samePlayback = active && !starting && selectedId === incomingId
        && spotify(item)?.spotifyUri === spotify(nextItem)?.spotifyUri;
      // The Open inside EveOS button is *not* another Play intent. Only an
      // explicit different queue item should command a Spotify source switch.
      if (!samePlayback && await audio.playItem(nextItem) === false) return false;
      return showEdgePanel(audio);
    };
    audio.pause = async function edgePause() {
      if (!active) return original.pause();
      await request('pause'); notify('Pause requested in Spotify’s official embed.');
      return true;
    };
    audio.resume = async function edgeResume() {
      if (!active) return original.resume();
      await request('resume');
      notify('Trying Spotify’s own Play control. Use the card if automatic Play is unavailable.');
      return true;
    };
    audio.seek = async function edgeSeek(seconds) {
      if (!active) return original.seek(seconds);
      await request('seek', { seconds: Math.max(0, Number(seconds || 0)) });
      return true;
    };
    audio.stopAll = async function edgeStop() {
      if (active || starting) await stopEdge();
      return original.stopAll();
    };
    audio.stopItemLayers = async function edgeStopItem(id, preserveProvider = false) {
      if (!preserveProvider && (active || starting) && String(item?.id) === String(id)) await stopEdge();
      return original.stopItemLayers(id, preserveProvider);
    };
    audio.updateItemVolume = function edgeVolume(id, value, options = {}) {
      if (!active || String(item?.id || '') !== String(id || ''))
        return original.updateItemVolume(id, value, options);
      if (!(window.EveAudioflixVolumeTarget?.allows?.(item, options) ?? options.type === undefined)) return;
      const safe = Math.max(0, Math.min(1, Number(value) || 0));
      item.volume = safe;
      request('volume', { gain: gain(safe) }, 5000).catch(error => notify(error.message, true));
    };
    audio.getPlaybackState = () => active ? { ...playback } : original.getPlaybackState();
    if (original.getStatus) audio.getStatus = () => active
      ? { ...original.getStatus(), item, playback: { ...playback }, spotifyEdge: ns.snapshot() }
      : original.getStatus();
    return true;
  }
  Object.assign(ns, { ready: true, install, stop: stopEdge,
    show: () => request('show'), hide: () => request('hide'),
    snapshot: () => ({ active, starting, item, playback: { ...playback }, lastRoute, windowHidden }) });
  if (!install()) window.addEventListener('load', install, { once: true });
})();
