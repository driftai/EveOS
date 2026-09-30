(() => {
  function bufferedAhead() {
    if (!mediaVideo?.buffered?.length) return 0;
    const current = currentMediaPosition();
    let end = current;
    for (let index = 0; index < mediaVideo.buffered.length; index += 1) {
      const start = mediaVideo.buffered.start(index), rangeEnd = mediaVideo.buffered.end(index);
      if (current >= start - 0.05 && current <= rangeEnd + 0.05) { end = rangeEnd; break; }
    }
    return Math.max(0, end - current);
  }
  function snapshot() {
    const quality = mediaVideo?.getVideoPlaybackQuality?.();
    return {
      kind: mediaVideo ? 'media' : null,
      provider: state?.source?.provider || state?.source?.server || null,
      currentTime: currentMediaPosition(),
      duration: mediaDuration(),
      paused: !!mediaVideo?.paused,
      playbackRate: Number(mediaVideo?.playbackRate) || 1,
      readyState: Number(mediaVideo?.readyState) || 0,
      networkState: Number(mediaVideo?.networkState) || 0,
      bufferedAheadSec: bufferedAhead(),
      width: Number(mediaVideo?.videoWidth) || 0,
      height: Number(mediaVideo?.videoHeight) || 0,
      totalFrames: Number(quality?.totalVideoFrames) || 0,
      droppedFrames: Number(quality?.droppedVideoFrames) || 0,
      hls: hlsInstance ? {
        currentLevel: Number(hlsInstance.currentLevel),
        nextAutoLevel: Number(hlsInstance.nextAutoLevel),
        bandwidthEstimate: Number(hlsInstance.bandwidthEstimate) || 0,
        levels: (hlsInstance.levels || []).map(level => ({
          width: Number(level.width) || 0,
          height: Number(level.height) || 0,
          bitrate: Number(level.bitrate) || 0
        }))
      } : null
    };
  }
  window.watchFusionMediaDiagnostics = { snapshot };
})();
