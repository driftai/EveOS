'use strict';
// Argument parsing and the one approved storage location for the spike.
const path = require('node:path');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(raw);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function load(argv = process.argv.slice(1)) {
  const a = parseArgs(argv);
  const source = a.source === 'spotify' ? 'spotify' : 'tone';
  const spotifyUrl = String(a['spotify-url'] || 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
  const embed = new URL(spotifyUrl);
  if (embed.protocol !== 'https:' || embed.hostname !== 'open.spotify.com' || !embed.pathname.startsWith('/embed/')) {
    throw new Error('--spotify-url must be an https://open.spotify.com/embed/... URL');
  }
  return {
    source,
    spotifyUrl: embed.toString(),
    // Every byte the spike writes (Electron userData, JSON reports) lives here and nowhere else.
    // Defaults inside this experiment folder (gitignored). No audio is ever written.
    dataDir: path.resolve(String(a['data-dir'] || path.join(__dirname, '.run'))),
    bridge: String(a.bridge || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    deviceId: String(a['device-id'] || ''),          // e.g. sd:7 (CABLE Input). Empty = capture only, no forwarding.
    decoy: a.decoy === true,                          // 880 Hz in an unrelated session: must NOT appear in capture.
    localEcho: a['local-echo'] === true,              // A/B ONLY: proves suppression by contrast. Never a GO config.
    persistSpotify: a['persist-spotify'] === true,    // authenticated phase only; profile under dataDir/userData.
    showSource: a['hide-source'] !== true
  };
}

module.exports = { load };
