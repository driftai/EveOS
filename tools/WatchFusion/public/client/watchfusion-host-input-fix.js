/* WatchFusion host-page source-tab compatibility.
 *
 * Keep this layer scoped to the actual WatchFusion source buttons. The host
 * window must remain a normal DOM event surface so header controls, inputs,
 * room controls, and the embedded player are not intercepted by a global
 * capture listener.
 */
(function installWatchFusionHostInputFix() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__watchFusionHostInputFixInstalled) return;
  window.__watchFusionHostInputFixInstalled = true;

  function $id(id) { return document.getElementById(id); }

  function setNuvioDomVisible() {
    const stage = $id('mediaStage');
    const host = $id('playerHost');
    const frame = $id('nuvioFrame');
    const toolbar = $id('nuvioToolbar');
    const yt = $id('player');
    if (stage) stage.classList.remove('media-stage-empty');
    if (host) host.classList.add('nuvio-active');
    if (frame) {
      frame.hidden = false;
      frame.style.display = 'block';
      if (!frame.src || frame.src === 'about:blank') frame.src = '/nuvio/dist/index.html';
    }
    if (toolbar) toolbar.hidden = false;
    if (yt) {
      yt.hidden = true;
      yt.style.display = 'none';
    }
    document.querySelectorAll('.source-tab').forEach(tab => {
      tab.classList.toggle('active', tab.id === 'shortcutNuvioBtn');
    });
    const label = $id('sourceModeLabel');
    if (label) label.textContent = 'Nuvio';
  }

  function openNuvio() {
    try {
      if (typeof window.openNuvioBrowserMode === 'function') {
        window.openNuvioBrowserMode();
        return;
      }
    } catch (error) {
      const status = $id('syncStatus');
      if (status) status.textContent = error?.message || 'Could not open Nuvio';
    }
    setNuvioDomVisible();
  }

  function openVoxelVision() {
    try {
      if (typeof window.openVoxelVisionMode === 'function') {
        window.openVoxelVisionMode();
        return;
      }
    } catch (error) {
      const status = $id('syncStatus');
      if (status) status.textContent = error?.message || 'Could not open VoxelVision';
    }
  }

  function openFindMedia() {
    const panel = $id('findMediaPanel');
    if (panel) panel.hidden = false;
    $id('sourceInput')?.focus?.();
    document.querySelectorAll('.source-tab').forEach(tab => {
      tab.classList.toggle('active', tab.id === 'resolveTabBtn');
    });
    const label = $id('sourceModeLabel');
    if (label) label.textContent = 'Ready';
  }

  function bindButton(button, action) {
    if (!button || button.__watchFusionHostInputBound) return;
    button.__watchFusionHostInputBound = true;
    button.addEventListener('click', event => {
      try {
        action(event);
      } catch (error) {
        const status = $id('syncStatus');
        if (status) status.textContent = error?.message || 'Source switch failed';
      }
    });
  }

  bindButton($id('shortcutNuvioBtn'), openNuvio);
  bindButton($id('shortcutVoxelVisionBtn'), openVoxelVision);
  bindButton($id('resolveTabBtn'), openFindMedia);
})();
