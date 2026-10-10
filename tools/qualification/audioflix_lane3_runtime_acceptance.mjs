#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const ports = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/eveos-ports.json'), 'utf8'));
const port = Number(ports?.ports?.EVEOS_WEB_PORT?.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Registered EVEOS_WEB_PORT required');
const base = `http://127.0.0.1:${port}`;
const args = [
    path.join(ROOT, 'tools/smoke/audioflix_spotify_long_queue_live_smoke.mjs'),
    `--base=${base}`,
    `--controller=${base}/EveOS.html`,
    `--engine=${base}/audioflix-spotify-engine.html`,
    '--count=8', '--start'
];
for (const flag of ['--headless', '--take-over', '--allow-visible-controller']) {
    if (process.argv.includes(flag)) args.push(flag);
}
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('LANE3_RUNTIME_ACCEPTANCE_OK durable=long-queue hidden-transition backend-isolation');
