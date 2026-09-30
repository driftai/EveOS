(() => {
  let host = null;
  let resizeObserver = null;
  let mutationObserver = null;

  function youtubeFrame(target = host) {
    if (!target) return null;
    return target.querySelector('iframe#player');
  }

  function clearFrameSize(frame) {
    if (!frame) return;
    frame.style.removeProperty('width');
    frame.style.removeProperty('height');
    frame.style.removeProperty('max-width');
    frame.style.removeProperty('max-height');
  }

  function fit() {
    if (!host?.isConnected) return;
    const frame = youtubeFrame();
    if (!frame) return;

    const maxWidth = Math.max(0, host.clientWidth);
    const maxHeight = Math.max(0, host.clientHeight);
    if (maxWidth < 2 || maxHeight < 2) return;

    let width = maxWidth;
    let height = width * 9 / 16;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * 16 / 9;
    }

    frame.style.width = `${Math.max(2, Math.floor(width))}px`;
    frame.style.height = `${Math.max(2, Math.floor(height))}px`;
    frame.style.maxWidth = '100%';
    frame.style.maxHeight = '100%';
  }

  function deactivate() {
    if (!host) return;
    const previous = host;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    resizeObserver = null;
    mutationObserver = null;
    host = null;
    previous.classList.remove('youtube-active');
    clearFrameSize(youtubeFrame(previous));
  }

  function activate(target = document.getElementById('playerHost')) {
    if (!target) return;
    if (host !== target) {
      deactivate();
      host = target;
    }
    host.classList.add('youtube-active');

    if (!resizeObserver && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => fit());
      resizeObserver.observe(host);
    }
    if (!mutationObserver && typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(() => fit());
      mutationObserver.observe(host, { childList: true, subtree: true });
    }

    requestAnimationFrame(fit);
    setTimeout(fit, 0);
  }

  window.watchFusionYoutubeLayout = Object.freeze({
    activate,
    deactivate,
    refresh: fit
  });
})();
