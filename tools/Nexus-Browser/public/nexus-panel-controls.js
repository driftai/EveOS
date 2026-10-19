(() => {
  'use strict';

  function visiblePanel(panel) {
    return !panel.closest('[hidden]');
  }

  function setPanelsExpanded(root, expanded) {
    const panels = [...root.querySelectorAll('details[data-nexus-collapsible]')]
      .filter(visiblePanel);
    for (const panel of panels) panel.open = expanded;
    return panels.length;
  }

  function createController(root = document) {
    const usageToggle = root.getElementById('nexusProviderUsageToggle');
    const usagePanel = root.getElementById('nexusProviderUsagePanel');
    const collapse = root.getElementById('nexusCollapsePanels');
    const expand = root.getElementById('nexusExpandPanels');
    if (!usageToggle || !usagePanel || !collapse || !expand) return null;

    function setUsageExpanded(expanded) {
      usagePanel.hidden = !expanded;
      usageToggle.setAttribute('aria-expanded', String(expanded));
      usageToggle.classList.toggle('active', expanded);
    }

    usageToggle.addEventListener('click', () => {
      setUsageExpanded(usageToggle.getAttribute('aria-expanded') !== 'true');
    });
    collapse.addEventListener('click', () => setPanelsExpanded(root, false));
    expand.addEventListener('click', () => setPanelsExpanded(root, true));
    setUsageExpanded(false);
    return { setUsageExpanded, setPanelsExpanded: (expanded) => setPanelsExpanded(root, expanded) };
  }

  const api = { createController, setPanelsExpanded, visiblePanel };
  globalThis.BrowserAiBridgeNexusPanels = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') createController(document);
})();
