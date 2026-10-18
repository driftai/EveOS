'use strict';
(() => {
  const root = document.getElementById('nexusCodexQuota');
  if (!root) return;
  const status = root.querySelector('[data-quota-status]');
  const rows = { fiveHour: root.querySelector('[data-window="fiveHour"]'), weekly: root.querySelector('[data-window="weekly"]') };
  const refresh = root.querySelector('[data-quota-refresh]');
  let snapshot = null;

  function drawWindow(row, value) {
    if (!row) return;
    const meter = row.querySelector('progress');
    const remaining = row.querySelector('[data-remaining]');
    const reset = row.querySelector('[data-reset]');
    if (!value) {
      meter.removeAttribute('value');
      remaining.textContent = 'Unavailable';
      reset.textContent = 'Reset time unavailable';
      return;
    }
    meter.value = value.remainingPercent;
    remaining.textContent = `${value.remainingPercent}% left`;
    if (!value.resetAt) { reset.textContent = 'Reset time unavailable'; return; }
    const time = new Date(value.resetAt).getTime();
    const mins = Math.max(0, Math.ceil((time - Date.now()) / 60000));
    const dateText = new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    reset.textContent = `Resets ${dateText} (${Math.floor(mins / 60)}h ${mins % 60}m)`;
  }

  function draw() {
    if (!snapshot || snapshot.state !== 'AVAILABLE') status.textContent = 'Quota unavailable — not zero';
    else if (snapshot.incomplete) status.textContent = 'Partial live quota — missing window';
    else status.textContent = 'Codex account usage';
    for (const [key, row] of Object.entries(rows)) drawWindow(row, snapshot?.[key]);
    const values = [snapshot?.fiveHour, snapshot?.weekly].filter(Boolean);
    root.dataset.quotaLevel = values.some((x) => x.remainingPercent <= 5) ? 'low' : 'normal';
  }

  async function update() {
    refresh.disabled = true;
    try {
      const response = await fetch('/codex/quota', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error('unavailable');
      snapshot = await response.json();
    } catch { snapshot = null; }
    finally { refresh.disabled = false; draw(); }
  }
  refresh.addEventListener('click', update);
  draw();
  update();
  setInterval(() => { if (!document.hidden) update(); else draw(); }, 60000);
})();
