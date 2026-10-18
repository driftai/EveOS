'use strict';
(() => {
  const root = document.getElementById('nexusCodexBurn');
  if (!root) return;
  const text = root.querySelector('[data-burn-text]');
  const details = root.querySelector('[data-burn-details]');
  function row(x) {
    const el = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${x.model} · ${x.effort} · ${x.samples} observed run(s)` +
      (x.confidence === 'INSUFFICIENT' ? ' · preliminary' : ' · observational');
    const numbers = document.createElement('span');
    numbers.textContent = ` 5h: ${x.medianFiveHourPoints} pts/run · week: ${x.medianWeeklyPoints} pts/run` +
      (x.medianFiveHourPointsPerElapsedHour == null ? '' : ` · 5h-window ${x.medianFiveHourPointsPerElapsedHour} pts/elapsed hour`);
    el.append(title, numbers);
    return el;
  }
  async function update() {
    try {
      const response = await fetch('/codex/quota', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error('unavailable');
      const body = await response.json();
      const burn = body.burn;
      details.replaceChildren();
      if (!burn?.models?.length) { text.textContent = 'No comparable measured runs yet'; return; }
      text.textContent = 'Observed allowance deltas by model / effort (not per-token costs)';
      for (const sample of burn.models.slice(0, 12)) details.appendChild(row(sample));
    } catch { text.textContent = 'Burn history unavailable'; }
  }
  update();
  setInterval(() => { if (!document.hidden) update(); }, 60000);
})();
