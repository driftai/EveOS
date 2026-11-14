/* UI bindings for the Sync Center. Playback and timing reports keep their existing owners. */
(() => {
  const center = $('watchSyncCenter');
  const more = $('syncCenterMore');
  const manual = $('devicePlaybackTiming');
  const diagnostics = $('presentationPanel');
  const slider = $('deviceTimingSlider');
  const numeric = $('deviceTimingInput');
  let lastCards = '';

  function setVisible(visible) {
    if (!center || center.hidden === !visible) return;
    center.hidden = !visible;
    if (!visible) {
      center.open = false;
      more.open = false;
      manual.open = false;
      diagnostics.open = false;
    }
  }

  function renderOffset(offset, text) {
    if (slider) {
      slider.value = String(offset);
      slider.setAttribute('aria-valuetext', text);
    }
    if (numeric && document.activeElement !== numeric) numeric.value = String(offset);
  }

  function bindOffset(stage, readDraft) {
    if (!numeric) return;
    numeric.addEventListener('input', () => {
      if (Number.isFinite(numeric.valueAsNumber)) stage(numeric.valueAsNumber);
    });
    // Normalize the field to the saved 5 ms step, including when it was cleared.
    numeric.addEventListener('blur', () => { numeric.value = String(readDraft()); });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderPeers(list, peers, members) {
    const names = new Map(members.map(({id, name}) => [id, name]));
    const signed = value => (value > 0 ? '+' : '') + Math.round(value) + ' ms';
    const cards = [...peers].sort((a, b) => a.member.localeCompare(b.member)).map(peer => ({
      name: names.get(peer.member) || 'Viewer',
      status: !peer.ready ? 'Loading' : peer.buffering ? 'Buffering' : peer.playing ? 'Playing' : 'Paused',
      metrics: [
        ['Player offset', peer.ready ? signed(peer.positionMs - peer.roomPositionMs) : null],
        ['Round trip', peer.rttMs == null ? null : Math.round(peer.rttMs) + ' ms'],
        ['Source sample age', peer.sourceAgeMs == null ? null : Math.round(peer.sourceAgeMs) + ' ms'],
        ['Video frame', peer.videoFrameOffsetMs == null ? null : signed(peer.videoFrameOffsetMs)],
        ['Corrections', peer.corrections == null ? null : String(peer.corrections)]
      ].filter(([, value]) => value !== null)
    }));
    const nextCards = JSON.stringify(cards);
    if (nextCards === lastCards) return;
    lastCards = nextCards;
    list.replaceChildren(...cards.map(({name, status, metrics}) => {
      const row = element('li', 'sync-peer-card');
      const heading = element('div', 'sync-peer-head');
      const stateClass = status === 'Playing' ? '' : status === 'Buffering' ? ' is-buffering' : ' is-idle';
      heading.append(element('strong', 'sync-peer-name', name), element('span', 'sync-peer-state' + stateClass, status));
      const figures = element('div', 'sync-peer-metrics');
      for (const [label, value] of metrics) {
        const metric = element('span', 'sync-peer-metric');
        metric.append(element('span', '', label), element('b', '', value));
        figures.append(metric);
      }
      row.append(heading, figures);
      return row;
    }));
  }

  center?.addEventListener('toggle', () => { if (!center.open) more.open = false; });
  more?.addEventListener('toggle', () => {
    if (!more.open && diagnostics) diagnostics.open = false;
  });
  window.watchFusionSyncCenter = {setVisible, renderOffset, bindOffset, renderPeers};
})();
