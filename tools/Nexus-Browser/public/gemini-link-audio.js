(() => {
  let context = null;
  let nextStartAt = 0;
  const replies = new Map();
  const BAR_COUNT = 16;
  const WAVE_ACCENT = '#b39dff';

  function audioContext() {
    if (context) return context;
    const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextImpl) return null;
    context = new AudioContextImpl();
    return context;
  }

  function decodeBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function pcmBuffer(ctx, bytes, sampleRate, channels) {
    const frameCount = Math.floor(bytes.byteLength / (2 * channels));
    if (!frameCount) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = ctx.createBuffer(channels, frameCount, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const offset = (frame * channels + channel) * 2;
        output[frame] = view.getInt16(offset, true) / 32768;
      }
    }
    return buffer;
  }

  function schedulePcm(message, bytes) {
    const ctx = audioContext();
    if (!ctx || !bytes?.byteLength) return;
    const sampleRate = Math.max(8000, Number(message.sampleRate || 24000));
    const channels = Math.max(1, Math.min(2, Number(message.channels || 1)));
    const buffer = pcmBuffer(ctx, bytes, sampleRate, channels);
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.015, nextStartAt);
    source.start(startAt);
    nextStartAt = startAt + buffer.duration;
  }

  function unlock() {
    const ctx = audioContext();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  }

  function replyState(message) {
    const requestId = String(message?.requestId || '');
    if (!requestId) return null;
    let state = replies.get(requestId);
    if (!state) {
      state = {
        requestId,
        chunks: [],
        sampleRate: Math.max(8000, Number(message.sampleRate || 24000)),
        channels: Math.max(1, Math.min(2, Number(message.channels || 1))),
        source: null,
        analyser: null,
        playing: false,
        offset: 0,
        startedAt: 0,
        pauseRequested: false,
        raf: 0,
        player: null
      };
      replies.set(requestId, state);
    }
    return state;
  }

  function combinedBytes(state) {
    const size = state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of state.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  function durationFor(state) {
    const bytes = state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    return bytes / Math.max(1, state.sampleRate * state.channels * 2);
  }

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
  }

  function drawBars(canvas, values) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    const slot = width / values.length;
    const barWidth = Math.max(2, slot * 0.55);
    ctx.fillStyle = WAVE_ACCENT;
    values.forEach((raw, index) => {
      const value = Math.max(0, Math.min(1, Number(raw) || 0));
      const barHeight = Math.max(2, value * (height - 2));
      const x = index * slot + (slot - barWidth) / 2;
      ctx.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
    });
  }

  function idleBars() {
    return new Array(BAR_COUNT).fill(0.07);
  }

  function assistantNode(requestId) {
    if (!requestId) return null;
    return document.querySelector(`[data-message-id="assistant-${CSS.escape(requestId)}"]`);
  }

  function stopReplay(state, keepOffset = true) {
    const ctx = audioContext();
    if (state.playing && keepOffset && ctx) {
      state.offset = Math.max(0, Math.min(durationFor(state), ctx.currentTime - state.startedAt));
    }
    state.pauseRequested = keepOffset;
    try { state.source?.stop(); } catch {}
    state.source = null;
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    const play = state.player?.querySelector('[data-gemini-audio-play]');
    if (play) {
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Play Gemini voice reply');
    }
    const canvas = state.player?.querySelector('canvas');
    if (canvas) drawBars(canvas, idleBars());
  }

  function updateReplayFrame(state) {
    if (!state.playing || !state.player) return;
    const ctx = audioContext();
    if (!ctx) return;
    const duration = durationFor(state);
    const current = Math.max(0, Math.min(duration, ctx.currentTime - state.startedAt));
    const progress = state.player.querySelector('[data-gemini-audio-progress]');
    const time = state.player.querySelector('[data-gemini-audio-time]');
    if (progress) progress.style.width = `${duration > 0 ? (current / duration) * 100 : 0}%`;
    if (time) time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;

    const canvas = state.player.querySelector('canvas');
    if (canvas && state.analyser) {
      const data = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(data);
      const values = [];
      for (let bar = 0; bar < BAR_COUNT; bar += 1) {
        const index = Math.floor((bar / BAR_COUNT) * data.length);
        values.push((data[index] || 0) / 255);
      }
      drawBars(canvas, values);
    }
    state.raf = requestAnimationFrame(() => updateReplayFrame(state));
  }

  async function startReplay(state) {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (state.playing) return;

    const buffer = pcmBuffer(ctx, combinedBytes(state), state.sampleRate, state.channels);
    if (!buffer) return;
    if (state.offset >= buffer.duration) state.offset = 0;

    const source = ctx.createBufferSource();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    state.source = source;
    state.analyser = analyser;
    state.pauseRequested = false;
    state.playing = true;
    state.startedAt = ctx.currentTime - state.offset;
    source.onended = () => {
      const paused = state.pauseRequested;
      state.source = null;
      state.playing = false;
      if (!paused) state.offset = 0;
      state.pauseRequested = false;
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      const play = state.player?.querySelector('[data-gemini-audio-play]');
      if (play) play.textContent = '▶';
      const canvas = state.player?.querySelector('canvas');
      if (canvas) drawBars(canvas, idleBars());
      updatePlayerMetadata(state);
    };
    source.start(0, state.offset);

    const play = state.player?.querySelector('[data-gemini-audio-play]');
    if (play) {
      play.textContent = '❚❚';
      play.setAttribute('aria-label', 'Pause Gemini voice reply');
    }
    updateReplayFrame(state);
  }

  function updatePlayerMetadata(state) {
    if (!state.player) return;
    const duration = durationFor(state);
    const time = state.player.querySelector('[data-gemini-audio-time]');
    const progress = state.player.querySelector('[data-gemini-audio-progress]');
    if (time && !state.playing) time.textContent = `${formatTime(state.offset)} / ${formatTime(duration)}`;
    if (progress && !state.playing) progress.style.width = `${duration > 0 ? (state.offset / duration) * 100 : 0}%`;
  }

  function createReplayPlayer(state, host) {
    if (!state || !host) return;
    if (state.player?.isConnected) return;
    if (state.player && !state.player.isConnected) state.player = null;
    const existing = host.querySelector('.nexus-gemini-audio-player');
    if (existing) {
      state.player = existing;
      updatePlayerMetadata(state);
      return;
    }
    const player = document.createElement('div');
    player.className = 'nexus-gemini-audio-player';
    player.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 10px;border-radius:22px;background:#1d2634;border:1px solid rgba(179,157,255,.28);max-width:100%;box-sizing:border-box;';

    const play = document.createElement('button');
    play.type = 'button';
    play.dataset.geminiAudioPlay = '1';
    play.textContent = '▶';
    play.title = 'Replay Gemini voice reply';
    play.setAttribute('aria-label', 'Play Gemini voice reply');
    play.style.cssText = 'width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;background:#312a52;color:#fff;flex:0 0 auto;display:grid;place-items:center;padding:0;line-height:1;text-align:center;';

    const track = document.createElement('div');
    track.style.cssText = 'position:relative;flex:1 1 90px;min-width:70px;height:4px;border-radius:2px;background:rgba(255,255,255,.18);cursor:pointer;';
    const progress = document.createElement('div');
    progress.dataset.geminiAudioProgress = '1';
    progress.style.cssText = 'position:absolute;inset:0 auto 0 0;width:0%;height:100%;border-radius:2px;background:#7c4dff;';
    track.append(progress);

    const waveform = document.createElement('canvas');
    waveform.width = 132;
    waveform.height = 44;
    waveform.setAttribute('aria-hidden', 'true');
    waveform.style.cssText = 'width:66px;height:22px;flex:0 0 auto;opacity:.95;';
    drawBars(waveform, idleBars());

    const time = document.createElement('span');
    time.dataset.geminiAudioTime = '1';
    time.style.cssText = 'font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#d9e2ef;white-space:nowrap;';

    play.addEventListener('click', () => {
      if (state.playing) stopReplay(state, true);
      else startReplay(state).catch((error) => console.warn('Gemini Link replay failed:', error));
    });
    track.addEventListener('click', (event) => {
      const rect = track.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
      const wasPlaying = state.playing;
      if (wasPlaying) stopReplay(state, false);
      state.offset = durationFor(state) * ratio;
      updatePlayerMetadata(state);
      if (wasPlaying) startReplay(state).catch((error) => console.warn('Gemini Link replay seek failed:', error));
    });

    player.append(play, track, waveform, time);
    host.append(player);
    state.player = player;
    updatePlayerMetadata(state);
  }

  function attachReplay(requestId) {
    const state = replies.get(requestId);
    if (!state?.chunks.length) return false;
    const host = assistantNode(requestId);
    if (!host) return false;
    createReplayPlayer(state, host);
    updatePlayerMetadata(state);
    return true;
  }

  function scheduleReplayAttach(requestId) {
    if (attachReplay(requestId)) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attachReplay(requestId) || attempts >= 40) clearInterval(timer);
    }, 50);
  }

  function attachManual(host, attachment = {}, key = '') {
    if (!host || (attachment.encoding && attachment.encoding !== 'pcm_s16le')) return false;
    const base64 = String(attachment.base64 || attachment.audio || '');
    if (!base64) return false;
    const requestId = `manual:${String(key || attachment.requestId || 'gemini-link-audio')}`;
    let state = replies.get(requestId);
    if (!state) {
      state = replyState({
        requestId,
        sampleRate: Number(attachment.sampleRate || 24000),
        channels: Number(attachment.channels || 1)
      });
    }
    if (!state) return false;
    if (!state.chunks.length) {
      try {
        const bytes = decodeBase64(base64);
        if (!bytes.byteLength) return false;
        state.chunks.push(bytes);
      } catch (error) {
        console.warn('Gemini Link manual replay attachment failed:', error);
        return false;
      }
    }
    state.sampleRate = Math.max(8000, Number(attachment.sampleRate || state.sampleRate || 24000));
    state.channels = Math.max(1, Math.min(2, Number(attachment.channels || state.channels || 1)));
    createReplayPlayer(state, host);
    updatePlayerMetadata(state);
    return !!state.player;
  }

  function handle(message) {
    if (message?.providerId !== 'gemini-link-chat') return false;
    const requestId = String(message.requestId || '');

    if (message.type === 'response_audio') {
      if (message.encoding && message.encoding !== 'pcm_s16le') return true;
      unlock();
      try {
        const bytes = decodeBase64(message.audio);
        schedulePcm(message, bytes);
        const state = replyState(message);
        if (state && bytes.byteLength) {
          state.chunks.push(bytes);
          state.sampleRate = Math.max(8000, Number(message.sampleRate || state.sampleRate || 24000));
          state.channels = Math.max(1, Math.min(2, Number(message.channels || state.channels || 1)));
          scheduleReplayAttach(requestId);
          updatePlayerMetadata(state);
        }
      } catch (error) {
        console.warn('Gemini Link Nexus audio playback failed:', error);
      }
      return true;
    }

    if ((message.type === 'response_partial' || message.type === 'response_final') && replies.has(requestId)) {
      scheduleReplayAttach(requestId);
    }
    return false;
  }

  globalThis.addEventListener?.('pointerdown', unlock, { passive: true });
  globalThis.addEventListener?.('keydown', unlock, { passive: true });
  globalThis.BrowserAiBridgeGeminiLinkAudio = { handle, unlock, attachManual, _replies: replies };
  if (typeof module !== 'undefined' && module.exports) module.exports = { handle, attachManual };
})();
