/** One committed scrub, bounded local-source recovery, and decoder arbitration. */
export class MediaPlaybackHealth {
  constructor(app, seekBar, timeDisplay) {
    this.app = app;
    this.video = app.video;
    this.scrubbing = false;
    this.seeking = false;
    this.recovering = false;
    this.retries = 0;
    this.generation = 0;
    this.lastProgress = performance.now();
    this.lastTime = 0;
    this.wantsPlay = false;
    seekBar.addEventListener('input', () => {
      this.scrubbing = true;
      this.beginSeek();
      const time = Number(seekBar.value) * this.video.duration / 100;
      if (Number.isFinite(time)) timeDisplay.textContent = `${app.formatTime(time)} / ${app.formatTime(this.video.duration)}`;
    });
    const commit = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      const time = Number(seekBar.value) * this.video.duration / 100;
      if (Number.isFinite(time)) this.video.currentTime = Math.max(0, time);
      // Setting the existing time need not dispatch a seeked event.
      if (!this.video.seeking) this.finishSeek();
    };
    seekBar.addEventListener('change', commit);
    seekBar.addEventListener('pointerup', commit);
    seekBar.addEventListener('blur', commit);
    seekBar.addEventListener('pointercancel', commit);
    this.video.addEventListener('seeking', () => this.beginSeek());
    this.video.addEventListener('seeked', () => this.finishSeek());
    this.video.addEventListener('play', () => { this.wantsPlay = true; this.lastProgress = performance.now(); });
    this.video.addEventListener('pause', () => {
      if (!this.recovering && !this.video.error) this.wantsPlay = false;
    });
    this.video.addEventListener('loadstart', () => {
      if (this.recovering) return;
      this.generation++;
      this.retries = 0;
      this.lastProgress = performance.now();
      this.finishSeek();
    });
    this.video.addEventListener('timeupdate', () => {
      if (!this.video.seeking && Math.abs(this.video.currentTime - this.lastTime) > 0.01) {
        this.lastProgress = performance.now();
        this.lastTime = this.video.currentTime;
      }
    });
    this.video.addEventListener('error', () => this.recover());
    this.watchdog = setInterval(() => {
      if (this.wantsPlay && !this.scrubbing && !this.video.ended
        && performance.now() - this.lastProgress > 15000) this.recover();
    }, 3000);
  }
  beginSeek() {
    this.app.isSeeking = true;
    this.app.depthPlayback.controller.setPlaybackSeeking(true);
    if (this.seeking) return;
    this.seeking = true;
    this.lastProgress = performance.now();
    this.app.depthPlayback.fusion.reset();
    // A hidden analysis result remains valid for its captured timestamp. Only
    // the live player's in-flight result becomes stale when the player seeks.
    if (this.app.depthPlayback.mode !== 'hybrid') this.app.liveDepth.requestImmediate({ resetTemporal: true });
    this.app.liveDepthFrameA = this.app.liveDepthFrameB = null;
  }
  finishSeek() {
    if (this.scrubbing || this.recovering) return;
    this.seeking = false;
    this.app.isSeeking = false;
    this.lastProgress = performance.now();
    this.app.depthPlayback.controller.setPlaybackTime(this.video.currentTime);
    this.app.depthPlayback.controller.setPlaybackSeeking(false);
    this.app.videoFrameVersion++;
    this.app.videoFrameMetadata.mediaTime = this.video.currentTime;
  }
  async recover() {
    const video = this.video;
    const src = video.getAttribute('src');
    if (this.recovering || !src || this.retries >= 2) return;
    // Unsupported files require a different source; network/decode failures can retry locally.
    if (video.error?.code === 4) return;
    this.recovering = true;
    this.retries++;
    const generation = this.generation;
    const sourceGeneration = this.app.sourceGeneration;
    const time = Number.isFinite(video.currentTime) ? video.currentTime : this.lastTime;
    const playing = this.wantsPlay;
    const rate = video.playbackRate;
    this.beginSeek();
    this.app.showStatus('Recovering local video playback…');
    let cleanup = () => {};
    try {
      const ready = new Promise((resolve, reject) => {
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Local media reload failed')); };
        const timer = setTimeout(failed, 12000);
        cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', loaded);
          video.removeEventListener('error', failed);
        };
        video.addEventListener('loadedmetadata', loaded);
        video.addEventListener('error', failed);
      });
      video.pause();
      video.load();
      await ready;
      if (generation !== this.generation || sourceGeneration !== this.app.sourceGeneration || video.getAttribute('src') !== src) return;
      video.playbackRate = rate;
      video.currentTime = Math.min(time, Math.max(0, video.duration - 0.01));
      if (playing) await video.play();
      this.app.showStatus('Local playback recovered; cached depth retained.', { hideAfter: 2500 });
    } catch {
      if (sourceGeneration === this.app.sourceGeneration) this.app.showStatus('Local playback could not recover. Reopen this video from the cache library.', { error: true, hideAfter: 6000 });
    } finally {
      cleanup();
      this.recovering = false;
      if (!video.seeking) this.finishSeek();
    }
  }
}
