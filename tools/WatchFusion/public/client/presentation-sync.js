/* Room timing telemetry and one-microphone, two-speaker calibration. */
(() => {
  const panel = $('presentationPanel');
  if (!panel) return;
  const $p = id => $('presentation' + id);
  const acoustics = window.WatchFusionAcoustics;
  const Audio = window.AudioContext || window.webkitAudioContext;
  const canRecord = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!Audio && !!window.AudioWorkletNode;
  let key = '', peers = [], proposal = null, applied = null, capture = null, result = null;
  let reference = null, receiver = null, requestPending = false, outputSession = makeClientId(), consumedProposal = null;
  let videoFrame = null, frameOwner = null, frameCallback = null, statusMessage = '', lastPeerText = '';
  let panelReady = false;
  const sourceSpeaker = 'linked-source';

  function mode() {
    if (state?.source?.kind === 'media' && state.source.url) return 'direct';
    return state?.source?.videoId ? 'youtube' : null;
  }

  function identity() {
    if (!roomId || !session || !mode()) return '';
    const source = state.source;
    return JSON.stringify([roomId, session.memberId, state.hostId, state.presentationEpoch, mode(), source.url || source.videoId, !!state.linkedSourceActive]);
  }

  function invalidate() {
    capture?.abort();
    stopTrackingFrames();
    capture = reference = receiver = result = proposal = applied = null;
    peers = [];
    panelReady = false;
    consumedProposal = null;
    statusMessage = '';
  }

  function setStatus(text) {
    statusMessage = text;
    $p('Status').textContent = text;
  }

  function timing() {
    const modeName = mode(), playback = state?.playback;
    if (!playback || !modeName) return null;
    const at = estimatedServerNow(), media = modeName === 'direct' ? mediaVideo : ytPlayer;
    const direct = modeName === 'direct', ytState = direct ? null : media?.getPlayerState?.();
    const position = direct ? media?.currentTime : media?.getCurrentTime?.();
    if (!media || !Number.isFinite(position) || (direct && mediaLoadedUrl !== state.source.url) || (!direct && media.getVideoData?.()?.video_id !== state.source.videoId)) return null;
    const rate = direct ? media.playbackRate : media.getPlaybackRate?.();
    const anchor = Number(playback.projectedAt ?? state.serverTime);
    const base = Number(playback.position);
    if (!Number.isFinite(anchor) || !Number.isFinite(base) || !Number.isFinite(rate) || rate <= 0) return null;
    const running = !playback.paused && !playback.ended;
    const positionMs = position * 1000;
    const roomPositionMs = base * 1000 + (running ? Math.max(0, at - anchor) * (Number(playback.rate) || 1) : 0);
    const diagnostics = direct ? {correctiveSeeks:mediaSyncSeeks, action:mediaSyncAction} : window.watchFusionSyncDiagnostics?.();
    const sourceAgeMs = sourceSampleAge();
    const volume = direct ? media.volume : (media.getVolume?.() ?? 100) / 100;
    return {
      mode: modeName, sampledAt: at, positionMs, roomPositionMs, rate,
      playing: running && (direct ? !media.paused && !media.ended : ytState === 1),
      buffering: direct ? media.seeking || media.readyState < 3 : ytState === 3,
      ready: direct ? !!mediaPlayerReady : !!ytPlayerReady && !playerInitializing && !primingPlayer,
      audible: volume > .01 && (direct ? !media.muted : media.isMuted?.() === false),
      outputSession, follows: !isHost() && followsRoomPlayback(), adjustmentMs: applied?.adjustmentMs ?? diagnostics?.deviceDelayMs ?? 0,
      videoFrameOffsetMs: direct && videoFrame && performance.now() - videoFrame.at < 500 ? videoFrame.offset : null,
      rttMs: window.watchPartyClock.rttMs(), offsetMs: window.watchPartyClock.offsetMs(),
      corrections: diagnostics?.correctiveSeeks ?? null, recentCorrection: diagnostics?.action ?? null, sourceAgeMs
    };
  }

  function sourceSampleAge() {
    if (!window.watchFusionLinkedTab?.publishing?.()) return null;
    const at = window.watchFusionLinkedTab.metadata()?.sampledAt;
    return Number.isFinite(at) ? Math.max(0, Date.now() - at) : null;
  }

  function linkedTiming() {
    const local = timing(), metadata = window.watchFusionLinkedTab?.metadata?.();
    const age = sourceSampleAge(), rate = Number(metadata?.rate);
    if (!local || !metadata || age === null || age > 900 || !Number.isFinite(rate) || !Number.isFinite(metadata.currentTime) ||
        (local.mode === 'youtube' && window.parseYoutubeInput?.(metadata.pageUrl) !== state.source.videoId)) return null;
    // The paired browser supplies player timestamps, never evidence its speaker is audible.
    const lag = age * rate;
    return { ...local, sampledAt:local.sampledAt - age, roomPositionMs:local.roomPositionMs - lag,
      positionMs:metadata.currentTime * 1000, rate, playing:!metadata.paused && !metadata.ended,
      ready:metadata.currentTime > 0, audible:Number(metadata.volume) > .01, buffering:metadata.buffering === true, sourceAgeMs:age, follows:false };
  }

  function stopTrackingFrames() {
    if (frameCallback !== null) frameOwner?.cancelVideoFrameCallback?.(frameCallback);
    frameOwner = videoFrame = frameCallback = null;
  }

  function trackVideoFrames() {
    const video = mode() === 'direct' ? mediaVideo : null;
    if (frameOwner === video) return;
    stopTrackingFrames();
    frameOwner = video;
    if (!video?.requestVideoFrameCallback) return;
    const frame = (at, data) => {
      if (frameOwner !== video || !panel.open) return;
      // DOM presentation estimates are deliberately separate from speaker measurements.
      const offset = (video.currentTime - data.mediaTime) * 1000 / video.playbackRate + data.expectedDisplayTime - at;
      if (Number.isFinite(offset)) videoFrame = { at, offset };
      frameCallback = video.requestVideoFrameCallback(frame);
    };
    frameCallback = video.requestVideoFrameCallback(frame);
  }

  async function exchange(body, signal) {
    const active = identity();
    if (!active || state.presentationEpoch == null) throw new Error('Restart WatchFusion to load speaker sync.');
    const response = await fetch(apiUrl('/api/rooms/' + encodeURIComponent(roomId) + '/presentation'), {
      method: 'POST', cache: 'no-store', signal, headers: {'Content-Type':'application/json','x-member-id':session.memberId},
      body: JSON.stringify({epoch:state.presentationEpoch, ...body})
    });
    const data = await response.json().catch(() => ({}));
    if (identity() !== active) throw new Error('Room or playback source changed.');
    if (!response.ok) throw new Error(response.status === 404 || response.status === 405
      ? 'Restart WatchFusion to load speaker sync.' : data.error || 'Could not exchange room timing.');
    return data;
  }

  function adjustment(value) { return value ? Math.abs(Math.round(value)) + ' ms ' + (value < 0 ? 'earlier' : 'later') : '0 ms'; }
  function signed(value) { return (value > 0 ? '+' : '') + Math.round(value) + ' ms'; }
  function timingText(peer) {
    if (!peer.ready) return 'player loading';
    if (peer.buffering) return 'buffering';
    const parts = [peer.playing ? 'playing' : 'paused', 'player ' + signed(peer.positionMs - peer.roomPositionMs)];
    if (peer.rttMs != null) parts.push('RTT ' + Math.round(peer.rttMs) + ' ms');
    if (peer.videoFrameOffsetMs != null) parts.push('video frame ' + signed(peer.videoFrameOffsetMs));
    if (peer.sourceAgeMs != null) parts.push('source sample ' + Math.round(peer.sourceAgeMs) + ' ms old');
    if (peer.corrections != null) parts.push(peer.corrections + ' seeks' + (peer.recentCorrection ? ' · ' + peer.recentCorrection : ''));
    return parts.join(' · ');
  }
  function refreshOptions(select, candidates, preferred) {
    const selected = select.value || preferred;
    const items = candidates.map(peer => [peer.member, peer.member === sourceSpeaker ? 'Attached source tab (if audible)' : state.members?.find(member => member.id === peer.member)?.name || 'Viewer']);
    const serial = JSON.stringify(items);
    if (select.dataset.members === serial) return;
    select.dataset.members = serial;
    select.replaceChildren(...items.map(([value, name]) => new Option(name, value)));
    if (items.some(([value]) => value === selected)) select.value = selected;
  }

  function updatePanel() {
    const current = identity();
    if (key !== current) { key = current; invalidate(); }
    panel.hidden = !current;
    if (!current || !panel.open) return;
    if (proposal?.expiresAt <= estimatedServerNow()) proposal = null;
    if (reference && !capture && Date.now() - reference.recordedAt > 120000) reference = receiver = result = null;
    const names = state.members || [];
    const label = [...peers].sort((a,b) => a.member.localeCompare(b.member)).map(peer =>
      (names.find(item => item.id === peer.member)?.name || 'Viewer') + ' · ' + timingText(peer));
    const serialized = JSON.stringify([label, names.map(member => member.id)]);
    if (lastPeerText !== serialized) {
      lastPeerText = serialized;
      $p('Peers').replaceChildren(...label.map(line => {
        const row = document.createElement('li'); row.textContent = line; return row;
      }));
    }
    const host = isHost(), busy = !!capture;
    const candidates = peers.filter(peer => peer.ready);
    const following = candidates.filter(peer => peer.follows);
    const linked = host && linkedTiming();
    $p('Capture').hidden = !(host && canRecord && panelReady);
    if (host && canRecord && !busy) {
      const references = linked ? [...candidates, {member:sourceSpeaker}] : candidates;
      refreshOptions($p('Reference'), references, state.hostId);
      refreshOptions($p('Receiver'), following, following[0]?.member);
    }
    for (const name of ['Reference','Receiver','RecordReference','RecordReceiver']) $p(name).disabled = busy || !following.length || !candidates.length;
    $p('RecordReceiver').disabled ||= !reference;
    $p('Cancel').hidden = !busy;
    $p('Send').disabled = busy || !result;
    $p('Choice').hidden = !proposal && !applied;
    $p('Apply').hidden = !proposal;
    $p('Clear').hidden = !applied;
    if (proposal && !statusMessage) $p('Status').textContent = 'Measured adjustment ' + adjustment(proposal.adjustmentMs) + ' (±' + proposal.uncertaintyMs + ' ms). Keep the same speaker output.';
    else if (applied && !statusMessage) $p('Status').textContent = 'Measured adjustment active · ' + adjustment(applied.adjustmentMs) + '.';
    else if (!statusMessage) $p('Status').textContent = host && !canRecord
      ? 'To measure speaker delay, open WatchFusion on the laptop at 127.0.0.1 or on HTTPS.'
      : host && !following.length ? 'Open Speaker sync on the TV or phone to make it available here.'
      : 'Speaker delay is unmeasured. The latest player timing appears below.';
  }

  async function report() {
    updatePanel();
    if (!key || !panel.open || requestPending || document.visibilityState === 'hidden') return;
    trackVideoFrames();
    const report = timing();
    const active = key, controller = new AbortController();
    requestPending = true;
    const timeout = setTimeout(() => controller.abort(), 1800);
    try {
      const sentAt = Date.now();
      const data = await exchange(report?.rttMs != null ? {report} : {}, controller.signal);
      if (active !== key || !panel.open || controller.signal.aborted) return;
      window.watchPartyClock.update(data.serverTime, sentAt, Date.now(), data.serverReceivedAt);
      panelReady = true;
      if (result && !capture && !data.peers.some(item => item.member === receiver?.member)) result = null;
      const next = data.proposal?.id !== consumedProposal && data.proposal?.outputSession === outputSession ? data.proposal : null;
      if (next && next.id !== proposal?.id) statusMessage = '';
      proposal = next;
      peers = data.peers;
      updatePanel();
    } catch (error) {
      if (active === key && panel.open && !capture) setStatus(error.message);
    } finally {
      clearTimeout(timeout);
      requestPending = false;
    }
  }

  function chooseTiming(samples, frames) {
    const usable = samples.filter(sample => sample.playing && sample.ready && sample.audible && !sample.buffering
      && Number.isFinite(sample.rttMs) && sample.rttMs <= 45);
    if (usable.length < 4 || samples.length !== usable.length || usable.at(-1).sampledAt - usable[0].sampledAt < 2500 ||
        Math.abs(usable[0].sampledAt - frames) > 1500 || usable.at(-1).sampledAt - frames > 6200) return null;
    const rate = usable[0].rate, roomRate = Number(state.playback.rate) || 1;
    if (usable.some(sample => Math.abs(sample.rate - rate) > .001 || sample.outputSession !== usable[0].outputSession) || Math.abs(rate - roomRate) > .001) return null;
    const projected = usable.map(sample => sample.positionMs + (frames - sample.sampledAt) * rate).sort((a,b) => a-b);
    const phases = usable.map(sample => sample.positionMs - sample.roomPositionMs).sort((a,b) => a-b);
    const jitterMs = (projected.at(-1) - projected[0]) / 2;
    if (jitterMs > 18 || phases.at(-1) - phases[0] > 40) return null;
    const middle = usable[Math.floor(usable.length / 2)];
    return {
      rate, outputSession: usable[0].outputSession, positionMs: projected[Math.floor(projected.length / 2)],
      roomPositionMs: middle.roomPositionMs + (frames - middle.sampledAt) * roomRate,
      rttMs: Math.max(...usable.map(sample => sample.rttMs)), jitterMs: Math.ceil(jitterMs)
    };
  }

  async function peerSample(member, signal) {
    if (member === sourceSpeaker) return linkedTiming();
    if (member === session.publicId) return timing();
    const data = await exchange({}, signal);
    return data.peers.find(peer => peer.member === member);
  }

  async function record(which) {
    if (capture || !canRecord || !isHost() || !panel.open) return;
    const member = $p(which === 'reference' ? 'Reference' : 'Receiver').value;
    if (!member || (which === 'receiver' && (!reference || member === reference.member))) {
      setStatus('Choose two different speakers.'); return;
    }
    const active = key, generation = outputSession;
    const controller = new AbortController(), { signal } = controller;
    capture = controller;
    result = null;
    receiver = null;
    if (which === 'reference') reference = null;
    updatePanel();
    setStatus('Preparing microphone…');
    let stream, context, node, timer, deadline;
    try {
      context = new Audio();
      const started = context.resume().catch(() => {});
      signal.addEventListener('abort', () => {
        stream?.getTracks().forEach(item => item.stop());
        if (context.state !== 'closed') void context.close().catch(() => {});
      }, {once:true});
      stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}});
      if (signal.aborted || key !== active) return;
      const track = stream.getAudioTracks()[0], settings = track?.getSettings?.() || {};
      if (!track || settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl) throw new Error('Turn off microphone processing to measure speaker timing.');
      const profile = JSON.stringify([settings.deviceId, settings.sampleRate, context.sampleRate]);
      if (which === 'receiver' && reference?.profile !== profile) throw new Error('The microphone changed. Record the reference again.');
      track.addEventListener('ended', () => { setStatus('Microphone disconnected.'); controller.abort(); }, {once:true});
      await started;
      await context.audioWorklet.addModule(new URL('/client/acoustic-microphone.worklet.js', location.origin));
      if (signal.aborted) return;
      node = new AudioWorkletNode(context, 'watchfusion-microphone');
      const silent = context.createGain();
      silent.gain.value = 0;
      context.createMediaStreamSource(stream).connect(node).connect(silent).connect(context.destination);
      const samples = [];
      let sampling = false;
      const take = async () => {
        if (sampling || signal.aborted) return;
        sampling = true;
        try {
          const sample = await peerSample(member, signal);
          const now = estimatedServerNow();
          if (sample && now - sample.sampledAt < 1400 && sample.sampledAt > (samples.at(-1)?.sampledAt ?? -Infinity)) {
            // Each untrusted report is validated again before it can influence a measurement.
            samples.push(sample);
          }
        } catch { /* Missing samples make this run inconclusive. */ }
        finally { sampling = false; }
      };
      timer = setInterval(() => void take(), 350);
      void take();
      setStatus('Recording for five seconds. Keep only the selected speaker audible.');
      const clockBefore = estimatedServerNow() - context.currentTime * 1000;
      const recording = await new Promise((resolve, reject) => {
        const fail = () => reject(new Error('Recording ended before a complete sample was available.'));
        signal.addEventListener('abort', fail, {once:true});
        deadline = setTimeout(fail, 7000);
        node.port.onmessage = ({data}) => resolve(data);
        node.port.postMessage('record');
      });
      if (generation !== outputSession || active !== key || signal.aborted) return;
      const clockAfter = estimatedServerNow() - context.currentTime * 1000;
      const clockJitter = Math.abs(clockAfter - clockBefore) / 2;
      if (clockJitter > 12) throw new Error('Microphone timing was unstable. Replay the section while this page stays visible.');
      const startedAt = recording.time * 1000 + (clockBefore + clockAfter) / 2;
      const frameTiming = chooseTiming(samples, startedAt);
      if (!frameTiming) throw new Error('Player timing was unstable or unavailable. Replay a steady section and record again.');
      frameTiming.jitterMs += Math.ceil(clockJitter);
      const captured = { member, timing: frameTiming, envelope: recording.envelope, profile, generation, recordedAt: Date.now() };
      if (which === 'reference') {
        reference = captured;
        setStatus('Reference captured. Replay the same section with only the second speaker audible.');
      } else {
        if (!reference || reference.generation !== generation || Date.now() - reference.recordedAt > 120000) throw new Error('Record the reference again.');
        receiver = captured;
        const expected = (reference.timing.positionMs - receiver.timing.positionMs) / reference.timing.rate;
        const detection = acoustics.estimate(reference.envelope, receiver.envelope, expected);
        result = acoustics.measure(reference.timing, receiver.timing, detection);
        receiver.envelope = null;
        if (!result) { receiver = null; throw new Error('Could not confidently match these recordings. Replay the reference section and reduce background sound.'); }
        setStatus('Estimated speaker-path gap ' + signed(result.observedMs) + ' (±' + result.uncertaintyMs + ' ms). Estimated current gap ' + signed(result.residualMs) + '. Suggested adjustment ' + adjustment(result.adjustmentMs) + '.');
      }
    } catch (error) {
      if (!signal.aborted && identity() === active) setStatus(error.message || 'Microphone capture failed.');
    } finally {
      clearInterval(timer); clearTimeout(deadline);
      controller.abort();
      if (capture === controller) capture = null;
      for (const track of stream?.getTracks() || []) track.stop();
      node?.disconnect();
      if (context && context.state !== 'closed') void context.close().catch(() => {});
      updatePanel();
    }
  }

  async function send() {
    if (!result || !receiver || !isHost()) return;
    const candidate = result, active = key, generation = outputSession, target = receiver.member, targetOutput = receiver.timing.outputSession;
    result = null;
    updatePanel();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 1800);
    try {
      await exchange({proposal:{target, outputSession:targetOutput, id:makeClientId(), ...candidate}}, controller.signal);
      if (key === active && generation === outputSession) setStatus('Measured adjustment sent. Apply it on that viewer, then select the next speaker or close this panel.');
    } catch (error) {
      if (key === active && generation === outputSession) { result = candidate; setStatus(error.message); }
    } finally { clearTimeout(timeout); }
    updatePanel();
  }

  function resync(previous) {
    const current = timing();
    if (!current?.playing || current.buffering || !current.ready) return;
    const change = Math.abs(current.adjustmentMs - previous);
    if (mode() === 'direct') window.mediaPlayback?.sync?.({force:change > 400});
    else if (change >= 150) syncPlayer({force:true});
    else if (change > 0) window.applyAdaptiveViewerSync?.(true, true);
  }

  function apply() {
    if (!proposal || isHost() || !key || proposal.outputSession !== outputSession || proposal.expiresAt <= estimatedServerNow()) return;
    const current = timing();
    if (!current?.playing || current.buffering || !current.ready) { setStatus('Wait for playback to settle before applying.'); return; }
    const item = proposal;
    applied = { ...item, key, generation: outputSession };
    proposal = null;
    consumedProposal = item.id;
    void exchange({dismiss:item.id}).catch(() => {});
    setStatus('Measured adjustment active · ' + adjustment(item.adjustmentMs) + '.');
    resync(current.adjustmentMs);
    updatePanel();
  }

  function clear() {
    const previous = applied?.adjustmentMs;
    applied = null;
    void report();
    setStatus('Previous device timing restored.');
    updatePanel();
    resync(previous);
  }

  panel.addEventListener('toggle', () => {
    if (panel.open) { statusMessage = ''; void report(); }
    else {
      stopTrackingFrames();
      capture?.abort();
      reference = receiver = result = null;
    }
  });
  $p('Reference').addEventListener('change', () => { reference = receiver = result = null; updatePanel(); });
  $p('Receiver').addEventListener('change', () => { receiver = result = null; updatePanel(); });
  $p('RecordReference').addEventListener('click', () => void record('reference'));
  $p('RecordReceiver').addEventListener('click', () => void record('receiver'));
  $p('Cancel').addEventListener('click', () => { setStatus('Recording canceled.'); capture?.abort(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && capture) { setStatus('Recording canceled because this page was hidden.'); capture.abort(); }
  });
  $p('Send').addEventListener('click', () => void send());
  $p('Apply').addEventListener('click', apply);
  $p('Clear').addEventListener('click', clear);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    const previous = applied?.adjustmentMs;
    outputSession = makeClientId();
    invalidate();
    setStatus('Audio devices changed. Measure again for the current output.');
    resync(previous);
    updatePanel();
  });
  function activeAdjustment() {
    return applied?.key === identity() && applied.generation === outputSession ? applied : null;
  }

  window.watchFusionPresentation = {
    render: updatePanel,
    useManualTiming: () => { if (applied) { applied = null; setStatus('Advanced device timing active.'); updatePanel(); } },
    active: activeAdjustment,
    adjustmentMs: () => activeAdjustment()?.adjustmentMs ?? null,
    diagnostics: () => ({ mode: mode(), linked: !!state?.linkedSourceActive, local: timing(), attachedSource: linkedTiming(), peers, speakerMeasurement: activeAdjustment() && {
      adjustmentMs: applied.adjustmentMs, observedMs: applied.observedMs, uncertaintyMs: applied.uncertaintyMs
    } })
  };
  updatePanel();
  setInterval(() => { if (panel.open) void report(); }, 700);
})();
