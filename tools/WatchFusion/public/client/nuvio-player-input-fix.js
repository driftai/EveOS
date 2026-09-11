/* WatchFusion-side Nuvio presentation compatibility.
 * Mouse input is owned exclusively by nuvio-external-mouse-bridge.js. Keeping
 * this module presentation-only prevents duplicate control or seek handlers.
 */
(function installWatchFusionNuvioPlayerFix() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const installedDocs = new WeakSet();

  function installIntoNuvio(doc) {
    if (!doc || installedDocs.has(doc)) return;
    installedDocs.add(doc);

    const hideSecondarySeekPresentation = () => {
      const overlay =
        doc.getElementById('playerSeekOverlay') || doc.querySelector('.player-seek-overlay');
      if (!overlay) return;
      overlay.classList.add('hidden');
      overlay.style.setProperty('display', 'none', 'important');
      overlay.style.setProperty('visibility', 'hidden', 'important');
      overlay.style.setProperty('pointer-events', 'none', 'important');
    };

    const observer = new MutationObserver(hideSecondarySeekPresentation);
    observer.observe(doc.body || doc.documentElement, {
      childList: true,
      subtree: true
    });
    hideSecondarySeekPresentation();
  }

  function attach(frame) {
    if (!(frame instanceof HTMLIFrameElement) || frame.id !== 'nuvioFrame') return;
    const ready = () => {
      try {
        if (frame.contentDocument) installIntoNuvio(frame.contentDocument);
      } catch (_) {}
    };
    frame.addEventListener('load', ready);
    ready();
  }

  const scan = root => root?.querySelectorAll?.('#nuvioFrame')?.forEach?.(attach);
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.id === 'nuvioFrame') attach(node);
        scan(node);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan(document);
})();
