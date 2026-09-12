(function installEmbeddedNuvioToolbarLayout() {
  if (typeof document === 'undefined') return;
  const styleId = '__watchfusion_embedded_nuvio_toolbar_layout';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    html.eveos-embedded #mediaStage.player-wrap,
    html.eveos-embedded .player-wrap {
      display: grid !important;
      grid-template-rows: minmax(0, 1fr) auto !important;
      position: relative;
    }

    html.eveos-embedded .nuvio-toolbar,
    html.eveos-embedded .voxelvision-toolbar {
      position: relative;
      z-index: 70;
      flex: 0 0 auto;
      min-width: 0;
      min-height: 38px;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
    }

    html.eveos-embedded .nuvio-toolbar > button,
    html.eveos-embedded .voxelvision-toolbar > button,
    html.eveos-embedded .nuvio-toolbar > .nuvio-label,
    html.eveos-embedded .voxelvision-toolbar > .voxelvision-label {
      flex: 0 0 auto;
    }

    html.eveos-embedded .nuvio-toolbar-note,
    html.eveos-embedded .voxelvision-toolbar-note {
      display: none;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})();
