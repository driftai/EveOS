'use strict';
// Trusted local Spotify source shell only. Remote Spotify frames receive no Node or privileged IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eveSpotifyDirect', {
  onCommand(fn) { ipcRenderer.on('eve-spotify-direct:command', (_event, value) => fn(value)); },
  event(value) { ipcRenderer.send('eve-spotify-direct:event', value); }
});
