/** Cache sampling is independent of the live inference rate ceiling. */
export function cacheSampleRate(selected, liveFps, sourceFps = null) {
  const requested = Number(selected) || Number(liveFps) || 3;
  const limit = Number(sourceFps) > 0 ? Math.ceil(Number(sourceFps)) : 60;
  return Math.max(1, Math.min(60, limit, requested));
}

export function installCacheSampling(coordinator) {
  const select = document.getElementById('cacheSampleRate');
  select?.addEventListener('change', () => coordinator.scheduleRestart());
}

export function selectedCacheRate(app, source) {
  return cacheSampleRate(document.getElementById('cacheSampleRate')?.value,
    app.liveDepth.targetFps, source?.mediaInfo?.fps);
}

export function restoreCacheSampling(session) {
  const select = document.getElementById('cacheSampleRate');
  if (!select) return;
  const saved = session.generationEnvironment?.cacheSampling;
  const value = saved == null ? 'live' : String(saved);
  if (![...select.options].some(option => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value} cached maps/sec (restored)`;
    select.append(option);
  }
  select.value = value;
}
