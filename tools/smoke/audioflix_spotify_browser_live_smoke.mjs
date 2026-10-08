#!/usr/bin/env node

import readline from 'node:readline/promises';
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const argValue = (prefix, fallback) => process.argv.slice(2).find((item) => item.startsWith(`${prefix}=`))?.slice(prefix.length + 1) || fallback;
const base = argValue('--base', 'http://127.0.0.1:8765').replace(/\/$/, '');
const pageUrl = argValue('--page', `${base}/EveOS.html`);
const shouldStart = args.has('--start');
const requirePlaying = args.has('--require-playing');
const requireSignedIn = args.has('--require-signed-in');
const sweep = args.has('--volume-sweep');
const nonInteractive = args.has('--non-interactive');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonRequest(path, method = 'GET', body = null) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw new Error(payload?.reason || payload?.message || `HTTP ${response.status}`);
    return payload || {};
}

function checkStatus(status) {
    if (!status.ok) throw new Error('Spotify browser status is not healthy.');
    if (!status.nodeAvailable) throw new Error('Node.js readiness failed.');
    if (!status.playwrightAvailable) throw new Error('Playwright readiness failed.');
    if (!status.browserRunning || !status.helperReachable) throw new Error('Managed browser/helper is not reachable.');
    if (!status.pageAttached) throw new Error('Managed EveOS page is not attached.');
    if (!status.sessionPresent) throw new Error('Managed session is not present.');
    if (Object.prototype.hasOwnProperty.call(status, 'sessionId')) throw new Error('Public status leaked the managed session id.');
    if (!['signed-in', 'signed-out', 'unknown'].includes(String(status.authState))) throw new Error(`Invalid authState ${status.authState}`);
    if (requireSignedIn && status.authState !== 'signed-in') throw new Error(`Spotify auth state is ${status.authState}; signed-in required.`);
    if (requirePlaying) {
        if (Number(status.spotifyFrameCount || 0) < 1) throw new Error('No Spotify embed frame is visible in managed EveOS.');
        if (Number(status.mediaCount || 0) < 1) throw new Error('No Spotify media element has been discovered.');
        if (Number(status.playingCount || 0) < 1) throw new Error('No Spotify media element is currently playing.');
    }
}

if (shouldStart) {
    const started = await jsonRequest('/api/audioflix/spotify-browser/start', 'POST', { pageUrl });
    if (!started.ok) throw new Error(started.reason || 'Could not start managed Spotify browser.');
}

let status = await jsonRequest('/api/audioflix/spotify-browser/status');
checkStatus(status);
console.log('MANAGED SPOTIFY STATUS');
console.log(JSON.stringify({
    state: status.state,
    playwrightVersion: status.playwrightVersion,
    browserChannel: status.browserChannel,
    authState: status.authState,
    pageAttached: status.pageAttached,
    sessionPresent: status.sessionPresent,
    spotifyFrameCount: status.spotifyFrameCount,
    mediaCount: status.mediaCount,
    playingCount: status.playingCount,
    desiredVolume: status.desiredVolume
}, null, 2));

if (sweep) {
    if (!requirePlaying && Number(status.playingCount || 0) < 1) {
        throw new Error('Volume sweep needs a currently playing Spotify track. Add --require-playing after starting playback.');
    }
    const results = [];
    for (const volume of [1, 0.25, 0, 1]) {
        // This fixed qualification route accepts no session id and is rejected when an Origin header
        // is present. It is for an explicit localhost CLI smoke only; ordinary browser tabs must use
        // the injected session proof on the normal /volume route.
        const result = await jsonRequest('/api/audioflix/spotify-browser/qualify-volume', 'POST', { volume });
        if (!result.ok || !result.sessionMatch) throw new Error(`Volume ${volume} was not acknowledged by the managed helper.`);
        if (Number(result.mediaCount || 0) < 1) throw new Error(`Volume ${volume} found no Spotify media element.`);
        if (result.held !== true) throw new Error(`Volume ${volume} did not hold on the playing Spotify element.`);
        results.push({ volume, playingCount: result.playingCount, reached: result.reached, held: result.held, readback: result.playingVolumes });
        console.log(`SET ${Math.round(volume * 100)}% -> reached=${result.reached} held=${result.held} readback=${JSON.stringify(result.playingVolumes)}`);
        await sleep(1500);
    }
    if (!nonInteractive) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const heard = (await rl.question('Did you hear 100% -> 25% quieter -> 0% silent -> 100% restored? (y/n): ')).trim().toLowerCase();
        rl.close();
        if (!heard.startsWith('y')) throw new Error('Audible volume sweep was not confirmed.');
    }
    console.log('VOLUME_SWEEP_PASS');
    console.log(JSON.stringify(results, null, 2));
}

status = await jsonRequest('/api/audioflix/spotify-browser/status');
checkStatus(status);
console.log('AUDIOFLIX_SPOTIFY_BROWSER_LIVE_SMOKE_OK');
