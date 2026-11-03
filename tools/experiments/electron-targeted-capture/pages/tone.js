'use strict';
// Synthetic source: a steady sine at -12 dBFS. 440 Hz = designated source, 880 Hz = decoy.
const q = new URLSearchParams(location.search);
const hz = Number(q.get('hz')) || 440;
const label = q.get('label') || 'tone';
const ctx = new AudioContext();
const osc = new OscillatorNode(ctx, { frequency: hz });
const gain = new GainNode(ctx, { gain: 0.25 });
osc.connect(gain).connect(ctx.destination);
osc.start();
const s = document.getElementById('s');
const show = () => { s.textContent = `${label}: ${hz} Hz sine, -12 dBFS, ${ctx.state}`; document.title = `${label} ${hz}Hz ${ctx.state}`; };
ctx.onstatechange = show; show();
document.getElementById('toggle').onclick = () => (ctx.state === 'running' ? ctx.suspend() : ctx.resume());
