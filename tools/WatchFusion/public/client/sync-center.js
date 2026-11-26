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

  // R14t: remote timestamp observations are not playback proof.  In particular,
  // a bounded NTP-style clock never proves a YouTube decoder advanced one frame.
  // This is a read-only presentation qualifier; it never participates in sync actuation.
  function createProgressEvidence() {
    let scope = '', prior = new Map();
    const outcome = (state, qualified = false) => ({state, qualified});
    function inspect(peers, now, key) {
      if (key !== scope) { scope = key; prior.clear(); }
      const results = new Map();
      for (const peer of peers) {
        const id = peer.member;
        let invalid = null;
        if (!peer.ready) invalid = 'loading';
        else if (!peer.playing) invalid = 'paused';
        else if (peer.buffering) invalid = 'buffering';
        else if (peer.correcting === true || /^(?:rejoin-|hold-|rate-started|rate-converging|zero-converging|host-zero-centering|host-peer-rejoin|settling|stall-kick)/.test(peer.recentCorrection || '')) invalid = 'correcting';
        else if (!(peer.decoderRecovery?.outcome==='decoder-motion-restored'&&peer.sensor?.timelineState==='advancing'&&Number.isFinite(peer.sensor?.heldMs)&&peer.sensor.heldMs<=300) && (peer.startupPhase === 'decoder-stalled' || /^(?:viewer-stalled-while-playing|stall-recovery-exhausted|auto-correction-suspended)/.test(peer.recentCorrection || '') || peer.decoderRecovery?.outcome === 'terminal-recovery-spent')) invalid = 'stalled';
        else if (['decoder-buffering', 'decoder-warming', 'decoder-advancing', 'awaiting-play', 'awaiting-first-frame'].includes(peer.startupPhase)) invalid = 'warming';
        else if (!Number.isFinite(peer.sampledAt) || Math.abs(now - peer.sampledAt) > 1500) invalid = 'stale';
        else if (!Number.isFinite(peer.positionMs) || !Number.isFinite(peer.roomPositionMs)) invalid = 'unavailable';
        // R14v: a THIN network clock does not erase directly observed decoder progression.
        // It still prevents a millisecond-precision lock badge later in classifyPeer.
        else if (!['bounded','thin'].includes(peer.sensor?.clockState) ||
          !Number.isFinite(peer.sensor?.clockBoundMs) || peer.sensor.clockBoundMs > 100) invalid = 'clock-unverified';
        else if (Number.isFinite(peer.sensor?.heldMs) && peer.sensor.heldMs > 300) invalid = 'position-held';
        if (invalid) { prior.delete(id); results.set(id, outcome(invalid)); continue; }
        const at = peer.sampledAt, pos = peer.positionMs;
        let previous = prior.get(id);
        if (!previous) { previous = {at, pos, since:at, accepted:0, lastProgressAt:at}; prior.set(id, previous); results.set(id, outcome('verifying')); continue; }
        const dt = at - previous.at;
        if (dt <= 0 || dt < 200) {
          results.set(id, outcome(previous.accepted >= 2 && at - previous.since >= 1200 ? 'advancing' : 'verifying', previous.accepted >= 2 && at - previous.since >= 1200));
          continue;
        }
        if (dt > 3500) { prior.set(id, {at,pos,since:at,accepted:0,lastProgressAt:at}); results.set(id, outcome('verifying')); continue; }
        const moved = pos - previous.pos;
        const rate = Math.min(2, Math.max(.25, Number(state?.playback?.rate) || 1));
        const expected = dt * rate;
        if (moved < -200 || moved > expected * 1.8 + 250) {
          prior.set(id, {at,pos,since:at,accepted:0,lastProgressAt:at}); results.set(id, outcome('jumped')); continue;
        }
        if (moved < Math.max(40, expected * .45 - 80)) {
          previous.at = at; previous.pos = pos;
          if (at - previous.lastProgressAt > 2500) {
            previous.accepted = 0; previous.since = at;
            results.set(id, outcome('position-held'));
          } else results.set(id, outcome('verifying'));
          continue;
        }
        if (moved > expected * 1.6 + 150) {
          prior.set(id, {at,pos,since:at,accepted:0,lastProgressAt:at}); results.set(id, outcome('jumped')); continue;
        }
        // Continuous, bounded playback progression across multiple NEW samples.
        previous.at = at; previous.pos = pos;
        previous.accepted = Math.min(30, previous.accepted + 1);
        previous.lastProgressAt = at;
        const qualified = previous.accepted >= 2 && at - previous.since >= 1200;
        results.set(id, outcome(qualified ? 'advancing' : 'verifying', qualified));
      }
      for (const id of prior.keys()) if (!peers.some(p => p.member === id)) prior.delete(id);
      return results;
    }
    return {inspect};
  }
  const progressEvidence = createProgressEvidence();
  // R14u: the linked tab is an independent timeline reference. Its native tab
  // mute is an audio-routing fact, never a timing/phase correction input.
  function createSourceTimelineEvidence() {
    let scope = '', prior = null;
    function inspect(metadata, now, key) {
      if (key !== scope) { scope = key; prior = null; }
      if (!metadata || metadata.paused !== false || metadata.ended === true)
        return {state: 'unavailable', qualified: false};
      const at = Number(metadata.sampledAt), pos = Number(metadata.currentTime) * 1000;
      if (!Number.isFinite(at) || !Number.isFinite(pos) || at <= 0 || Math.abs(now - at) > 2000)
        return {state: 'stale', qualified: false};
      if (!prior || at - prior.at > 3500) {
        prior = {at, pos, firstAt: at, accepted: 0};
        return {state: 'verifying', qualified: false};
      }
      const delta = at - prior.at;
      if (delta < 200) return {state: prior.accepted >= 2 && prior.at - prior.firstAt >= 1000 ? 'advancing' : 'verifying',
        qualified: prior.accepted >= 2 && prior.at - prior.firstAt >= 1000};
      const rate = Math.min(2, Math.max(.25, Number(metadata.rate) || 1));
      const advanced = pos - prior.pos, expected = delta * rate;
      if (advanced < expected * .45 - 80 || advanced > expected * 1.6 + 160) {
        const state = advanced < expected * .45 - 80 ? 'held' : 'jumped';
        prior = {at, pos, firstAt: at, accepted: 0};
        return {state, qualified: false};
      }
      prior.at = at; prior.pos = pos;
      prior.accepted = Math.min(30, prior.accepted + 1);
      const qualified = prior.accepted >= 2 && at - prior.firstAt >= 1000;
      return {state: qualified ? 'advancing' : 'verifying', qualified};
    }
    return {inspect};
  }
  const sourceProgressEvidence = createSourceTimelineEvidence();
  const linkedMuteEvidence = (metadata, now) => {
    const at = Number(metadata?.sampledAt);
    if (!Number.isFinite(at) || at <= 0 || Math.abs(now - at) > 2000) return null;
    return typeof metadata.tabMuted === 'boolean' ? metadata.tabMuted : null;
  };
  const evidenceText = state => ({
    'loading':'Loading', 'paused':'Paused', 'buffering':'Buffering',
    'correcting':'Correcting', 'stalled':'Decoder stalled · timeline not advancing',
    'warming':'Playing · decoder warming', 'stale':'Playing · timing report stale',
    'unavailable':'Playing · timing unavailable', 'clock-unverified':'Playing · clock unverified',
    'position-held':'Playing · position not advancing', 'jumped':'Playing · timestamp jumped; rechecking',
    'verifying':'Playing · verifying timeline progression'
  })[state] || 'Playing · timing unverified';

  // Health and reported timeline precision are separate; no speaker timing is measured.
  function recoveryLabel(peer) {
    const raw = peer.hostRecovery?.outcome ?? (peer.member===state?.hostId && isHost() ? window.WatchFusionHostPeerRecovery?.diagnostics?.()?.outcome : null);
    const hostError=peer.hostRecovery?.hostErrorMs;
    const inBand=peer.member===state?.hostId && peer.playing && !peer.buffering &&
      Number.isFinite(hostError) && Math.abs(hostError)<=50;
    return raw === 'source-not-trusted' ? 'Reference not qualified for host recovery'
      : raw === 'no-healthy-peer-witness' && inBand ? 'Recovery not needed · host within 50 ms'
      : raw === 'no-healthy-peer-witness' ? 'No qualified peer witness for recovery' : raw;
  }
  // v13.8: status reflects actual drift and actuation, not merely PLAYING.
  function classifyPeer(peer, sourceError, evidence = null) {
    // Host media may be unembeddable while the linked source still advances.
    // This does not mean the room or the source tab is paused.
    if (!peer.playing && peer.member === state?.hostId && state?.linkedSourceActive === true &&
      state?.playback?.paused === false && window.watchFusionPlayout?.status?.()?.source === 'live')
      return 'Host player inactive · linked source live';
    if (evidence && !evidence.qualified) return evidenceText(evidence.state);
    if (!peer.ready) return 'Loading';
    if (peer.buffering) return 'Buffering';
    if (peer.correcting === true) return 'Correcting';
    if (!peer.playing) return 'Paused';
    // A late or thin player report cannot prove millisecond-scale lock, even
    // though the browser/player UI still claims PLAYING.
    const age = Number.isFinite(peer.sampledAt) ? Math.abs((typeof estimatedServerNow === 'function' ? estimatedServerNow() : Date.now()) - peer.sampledAt) : 0;
    if (age > 1500) return 'Playing · timing report stale';
    if (peer.sensor?.clockState === 'thin') return 'Playback advancing · thin-clock estimate';
    if (['stale','unstable'].includes(peer.sensor?.clockState)) return 'Playing · timing unverified';
    if (state?.linkedSourceActive && !Number.isFinite(sourceError)) return 'Playing · source timing unverified';
    if (state?.linkedSourceActive && Math.abs(sourceError) > 50) return 'Playing · linked source offset';
    const errorMs = Number.isFinite(peer.positionMs) && Number.isFinite(peer.targetPositionMs)
      ? Math.abs(peer.positionMs - peer.targetPositionMs) : null;
    return window.WatchFusionPrecisionPolicy?.label?.({ready:peer.ready,buffering:peer.buffering,playing:peer.playing,correcting:peer.correcting,errorMs,reason:peer.recentCorrection||peer.hostRecovery?.outcome}) || (errorMs===null?'Timing unavailable':errorMs>50?'Playing · offset reported':'Locked');
  }

  // Group agreement uses reported PLAYER-TIMELINE progression; speaker output is not measured.
  let groupHistory = {key: '', since: 0, samples: 0, last: null};
  function groupAligned(peers, now, gap, progress) {
    const clear = () => { groupHistory = {key: '', since: 0, samples: 0, last: null}; return false; };
    if (peers.length < 2 || peers.length > 8 || !Number.isFinite(gap) || gap > 50) return clear();
    const sorted = [...peers].sort((a, b) => a.member.localeCompare(b.member));
    if (!sorted.every(p => progress.get(p.member)?.qualified && p.ready && p.playing && !p.buffering && !p.correcting &&
      p.sensor?.clockState === 'bounded' &&
      !/^(?:rejoin-|hold-|rate-started|rate-converging|zero-converging|host-zero-centering|host-peer-rejoin|decoder-recovery|viewer-stalled-while-playing|stall-recovery-exhausted|auto-correction-suspended)/.test(p.recentCorrection || '') &&
      Number.isFinite(p.sampledAt) && Math.abs(now - p.sampledAt) < 1500 &&
      Number.isFinite(p.positionMs) && Number.isFinite(p.roomPositionMs))) return clear();
    const key = [state?.presentationEpoch, state?.playoutSegment, sorted.map(p => p.member).join(',')].join(':');
    const rows = sorted.map(p => ({t:p.sampledAt, position:p.positionMs}));
    if (groupHistory.key !== key || now < groupHistory.since) {
      groupHistory = {key, since:now, samples:1, last:rows}; return false;
    }
    const previous = groupHistory.last;
    let progressed = 0;
    for (let i = 0; i < rows.length; i++) {
      const elapsed = rows[i].t - previous[i].t, moved = rows[i].position - previous[i].position;
      if (elapsed < 0 || moved < -100) return clear();
      if (elapsed >= 200) {
        if (moved < elapsed * .35 || moved > elapsed * 1.65 + 200) return clear();
        progressed++;
      }
    }
    if (progressed === rows.length) { groupHistory.last = rows; groupHistory.samples++; }
    else if (now - groupHistory.since > 5000 && groupHistory.samples < 3) return clear();
    return groupHistory.samples >= 3 && now - groupHistory.since >= 1600;
  }

  function renderPeers(list, peers, members) {
    const names = new Map(members.map(({id, name}) => [id, name]));
    const signed = value => (value > 0 ? '+' : '') + Math.round(value) + ' ms';
    const now = typeof estimatedServerNow === 'function' ? estimatedServerNow() : Date.now();
    const scopeKey = [state?.presentationEpoch, state?.playoutSegment, state?.source?.videoId || '', state?.playback?.paused].join(':');
    const progress = progressEvidence.inspect(peers, now, scopeKey);
    const coordination = window.watchFusionPlayout?.status?.();
    const sourceMeta = state?.linkedSourceActive === true && window.watchFusionLinkedTab?.active?.() === true ? window.watchFusionLinkedTab?.metadata?.() : null;
    const sourceProgress = sourceProgressEvidence.inspect(sourceMeta, Date.now(), scopeKey);
    const sourceTabMuted = linkedMuteEvidence(sourceMeta, Date.now());
    const sourceLive = state?.linkedSourceActive === true && coordination?.source === 'live' &&
      coordination?.reference === 'linked-tab' && coordination?.authorityBuffering !== true &&
      Number.isFinite(coordination?.uncertaintyMs) && coordination.uncertaintyMs <= 125 &&
      Number.isFinite(coordination?.sourceReferenceAt) && now - coordination.sourceReferenceAt >= 0 &&
      now - coordination.sourceReferenceAt <= 1500;
    const qualifiedCount = peers.filter(p => progress.get(p.member)?.qualified).length;
    // The signed number is a PLAYER-TIMELINE observation, not speaker-output
    // phase. Keep the number visible but label thin/stale observations as such.
    const phaseEstimate = p => {
      if (!progress.get(p.member)?.qualified) return 'Unverified · no sustained player progression';
      if (!p.ready || !Number.isFinite(p.positionMs) || !Number.isFinite(p.targetPositionMs)) return null;
      if (!p.playing || p.buffering) return 'Unavailable while stopped/buffering';
      const value = signed(p.positionMs - p.targetPositionMs);
      const age = Number.isFinite(p.sampledAt) ? Math.abs(now - p.sampledAt) : Infinity;
      return age > 1500 || p.sensor?.clockState !== 'bounded' ? '≈ ' + value + ' (estimate only)' : value;
    };
    const compared = peers.filter(p => progress.get(p.member)?.qualified && !['held','slow','jumped'].includes(p.sensor?.timelineState))
      .map(p => ({p,position:window.WatchFusionPrecisionPolicy?.comparisonPosition(p,now,state?.playoutSegment)})).filter(x=>Number.isFinite(x.position));
    const roomOffsets = compared.map(x=>x.position);
    const gap = roomOffsets.length >= 2 ? Math.round(Math.max(...roomOffsets) - Math.min(...roomOffsets)) : null;
    const bounds = compared.map(({p})=>p.sensor?.clockState==='bounded'&&Number.isFinite(p.sensor.clockBoundMs)?p.sensor.clockBoundMs*p.rate:NaN);
    const clockOnlyUpper = gap!==null&&bounds.every(Number.isFinite)?Math.ceil(gap+bounds.sort((a,b)=>b-a).slice(0,2).reduce((a,b)=>a+b,0)+1):null;
    const expected=members.length,aligned = groupAligned(peers, now, roomOffsets.length===peers.length&&peers.length===expected?gap:null, progress);
    const playout = window.watchFusionPlayout;
    const cards = [...peers].sort((a, b) => a.member.localeCompare(b.member)).map((peer, index) => {
      const sourceError = peer.sensor?.clockState === 'bounded' ? playout?.sourceErrorMs?.(peer, coordination, now) : null;
      return {
      name: names.get(peer.member) || 'Viewer',
      status: aligned ? 'Player timelines aligned · audio not measured' : classifyPeer(peer, sourceError, progress.get(peer.member)),
      metrics: [
        // v13.10.8e: a signed player-vs-room number, not audible desync. The room clock is the muted source tab.
        // R14s: the first metric answers whether the TWO players agree. A shared
        // offset from the room/source clock is not evidence of TV-vs-laptop desync.
        ['Player-to-player timeline spread', index === 0 ? gap !== null ? gap + ' ms (' + compared.length+'/'+expected+' players; '+(aligned ? 'full room progression qualified' : compared.length<expected?'partial room':'provisional') + '; not speaker audio)' :
          peers.length < 2 ? 'N/A · single room player' : qualifiedCount === 1 ? 'N/A · only one advancing room player' : 'Unverified · no two advancing room players' : null],
        ['Clock-only spread upper estimate', index === 0 && clockOnlyUpper!==null ? clockOnlyUpper + ' ms (estimated; excludes decoder and speaker latency)' : null],
        ['Linked source reference', index === 0 && state?.linkedSourceActive ? sourceLive ? 'Live, bounded timeline · not speaker timing' : 'Reference not currently bounded' : null],
        ['Linked source progression', index === 0 && state?.linkedSourceActive && sourceMeta ?
          sourceProgress.qualified ? 'Source timeline advancing (local evidence)' : 'Source timeline ' + sourceProgress.state + ' (local evidence)' : null],
        ['Linked source tab mute', peer.member === state?.hostId && state?.linkedSourceActive && window.watchFusionLinkedTab?.active?.() ?
          sourceTabMuted === true ? 'Native tab mute confirmed' : sourceTabMuted === false ? 'NOT MUTED · check EveOS Bridge' : 'Unverified · check EveOS Bridge' : null],
        ['Host audio route', peer.member === state?.hostId && state?.linkedSourceActive && window.watchFusionLinkedTab?.active?.() ?
          sourceTabMuted === false && peer.playing ? 'DOUBLE AUDIO RISK · source + player' :
          sourceTabMuted === false && !peer.playing ? 'Source-tab fallback · host player inactive' :
          sourceTabMuted === true && !peer.playing ? 'Host player absent · source tab muted' :
          sourceTabMuted === true ? 'Room player · source tab muted' : 'Native mute ownership unverified' : null],
        ['Playback progression', peer.playing && peer.ready ? progress.get(peer.member)?.qualified ? 'Advancing · observed player timeline' : 'Not qualified · ' + (progress.get(peer.member)?.state || 'unknown') : null],
        ['Player vs room target (not audio)', phaseEstimate(peer)],
        ['Player vs linked source (estimate)', state?.linkedSourceActive ? progress.get(peer.member)?.qualified && Number.isFinite(sourceError) ? signed(sourceError) + ' (estimate)' : 'Unverified (player/source)' : null],
        ['Group evidence', index === 0 && aligned ? 'Advancing players within 50 ms; audio not measured' : null],
        ['Player-room position (diagnostic)', progress.get(peer.member)?.qualified && peer.ready ? signed(peer.positionMs - peer.roomPositionMs) : null],
        ['Timing adjustment', peer.ready && Math.abs(peer.adjustmentMs || 0) >= 1 ? signed(peer.adjustmentMs) : null],
        ['Round trip', peer.rttMs == null ? null : Math.round(peer.rttMs) + ' ms'],
        ['Source sample age', peer.sourceAgeMs == null ? null : Math.round(peer.sourceAgeMs) + ' ms'],
        ['Timing reference', peer.timingReference ?? null],
        ['Host correction', peer.hostCorrection ?? null],
        ['Host recovery gate', recoveryLabel(peer)],
        ['Precision action', peer.recentCorrection ?? null],
        ['Peer witnesses', peer.hostRecovery?.peerCount ? String(peer.hostRecovery.peerCount) : null],
        ['Video frame', peer.videoFrameOffsetMs == null ? null : signed(peer.videoFrameOffsetMs)],
        ['Corrections', peer.corrections == null ? null : String(peer.corrections)],
        ['Local viewer seeks', peer.member === session?.publicId ? (window.watchFusionSyncDiagnostics?.()?.arbiter?.seeks ?? null) : null],
        ['Position read held', Number.isFinite(peer.sensor?.heldMs) && peer.sensor.heldMs > 0 ? Math.round(peer.sensor.heldMs) + ' ms' : null],
        ['Audible output', ({player: 'This player', 'source-tab': 'Source tab, not this player', both: 'Player and source tab (double audio)', none: 'Muted'})[peer.sensor?.audibleOutput] ?? null],
        ['Network clock bound (not decoder)', peer.sensor?.clockState === 'bounded' && Number.isFinite(peer.sensor.clockBoundMs) ? 'within ±' + peer.sensor.clockBoundMs + ' ms (estimated)' : peer.sensor?.clockState && peer.sensor.clockState !== 'unknown' ? 'Unbounded (' + peer.sensor.clockState + ')' : null],
        ['Speaker phase', peer.ready ? 'Not measured' : null]
      ].filter(([, value]) => value !== null)
      };
    });
    const nextCards = JSON.stringify(cards);
    if (nextCards === lastCards) return;
    lastCards = nextCards;
    list.replaceChildren(...cards.map(({name, status, metrics}) => {
      const row = element('li', 'sync-peer-card');
      const heading = element('div', 'sync-peer-head');
      const stateClass = status === 'Correcting' || status === 'Recovery stalled' || status === 'Buffering' ? ' is-buffering' : status === 'Paused' ? ' is-idle' : '';
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
  window.watchFusionSyncCenter = {setVisible, renderOffset, bindOffset, renderPeers, classifyPeer};
  window.WatchFusionSyncProgressEvidence = {createProgressEvidence};
})();
