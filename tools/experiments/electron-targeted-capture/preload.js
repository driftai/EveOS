'use strict';
// Trusted capture page only. Exposes a narrow API; no Node, no bridge URL, no credentials.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', {
  config: () => ipcRenderer.invoke('spike:config'),
  pcm: (audio, sampleRate, gain) => ipcRenderer.send('spike:pcm', { audio: String(audio), sampleRate: Number(sampleRate), gain: Number(gain) }),
  stats: (s) => ipcRenderer.send('spike:stats', s),
  event: (e) => ipcRenderer.send('spike:event', e),
  source: (action) => ipcRenderer.invoke('spike:source', String(action)),
  metrics: () => ipcRenderer.invoke('spike:metrics'),
  onSourceGone: (fn) => ipcRenderer.on('spike:source-gone', () => fn())
});
