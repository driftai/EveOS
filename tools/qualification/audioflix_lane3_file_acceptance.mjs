#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeSpotify } from '../smoke/audioflix_spotify_long_queue_live_support.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const ports = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/eveos-ports.json'), 'utf8'));
const port = Number(ports?.ports?.EVEOS_WEB_PORT?.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Registered EVEOS_WEB_PORT required');
const base = `http://127.0.0.1:${port}`;
const response = await fetch(`${base}/api/eve-state/modular/load`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
if (!response.ok) throw new Error(`Canonical backend state read failed: HTTP ${response.status}`);
const payload = await response.json();
const audioflix = payload?.state?.audioflix ?? payload?.state?.bookmarks?.config?.audioflix ?? null;
const seen = new Set();
const sources = (audioflix?.music || []).map(item => normalizeSpotify(item?.spotifyUrl || item?.url || item?.originalUrl || ''))
    .filter(url => {
        const id = url.match(/\/track\/([A-Za-z0-9]{22})/i)?.[1];
        if (!id || seen.has(id)) return false;
        seen.add(id); return true;
    }).slice(0, 2);
if (sources.length < 2) throw new Error('Two existing real Spotify-linked backend sources required');
const args = [
    path.join(ROOT, 'tools/smoke/audioflix_spotify_long_queue_live_smoke.mjs'),
    `--base=${base}`,
    `--controller=${pathToFileURL(path.join(ROOT, 'EveOS.html')).href}`,
    `--engine=${base}/audioflix-spotify-engine.html`,
    `--tracks=${sources.join(';')}`, '--count=8', '--start'
];
if (process.argv.includes('--take-over')) args.push('--take-over');
if (process.argv.includes('--headless')) args.push('--headless');
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('LANE3_FILE_ACCEPTANCE_OK durable=file-controller backend-source-discovery backend-isolation');
