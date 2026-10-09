#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const profileArg = process.argv.find((item) => item.startsWith('--profile='));
const profile = profileArg ? profileArg.slice('--profile='.length) : (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'full');

const tests = {
    audio: [
        ['node', 'tools/smoke/audioflix_playback_diagnostics_smoke.cjs'],
        ['node', 'tools/smoke/audioflix_decode_cache_smoke.js'],
        ['node', 'tools/smoke/audioflix_layer_stop_smoke.js'],
        ['node', 'tools/smoke/audioflix_native_handoff_smoke.js'],
        ['node', 'tools/smoke/audioflix_queue_view_smoke.js'],
        ['node', 'tools/smoke/audioflix_music_native_capture_smoke.js']
    ],
    volume: [
        ['node', 'tools/smoke/audioflix_volume_managed_smoke.js'],
        ['node', 'tools/smoke/audioflix_volume_views_smoke.js'],
        ['node', 'tools/smoke/audioflix_output_port_smoke.js'],
        ['node', 'tools/smoke/audioflix_url_port_smoke.js']
    ],
    sounds: [
        ['node', 'tools/smoke/audioflix_soundboard_params_backup_smoke.js'],
        ['node', 'tools/smoke/audioflix_soundlab_playback_smoke.js'],
        ['node', 'tools/smoke/audioflix_soundlab_smoke.js'],
        ['node', 'tools/smoke/audioflix_soundlab_underrun_smoke.js']
    ],
    spotify: [
        ['node', 'tools/smoke/audioflix_spotify_browser_contract_smoke.js'],
        ['node', 'tools/smoke/audioflix_spotify_browser_runtime_smoke.js'],
        ['python', 'tools/smoke/audioflix_spotify_browser_python_smoke.py'],
        ['python', 'tools/smoke/audioflix_spotify_session_smoke.py'],
        ['node', 'tools/smoke/audioflix_spotify_browser_smoke.js'],
        ['node', 'tools/smoke/audioflix_spotify_engine_smoke.js'],
        ['node', 'tools/smoke/audioflix_spotify_playback_smoke.js'],
        ['node', 'tools/smoke/audioflix_spotify_scraper_smoke.js']
    ],
    state: [
        ['node', 'tools/smoke/audioflix_state_recovery_smoke.js'],
        ['node', 'tools/smoke/audioflix_backup_guard_smoke.js'],
        ['node', 'tools/smoke/audioflix_library_next_smoke.js']
    ]
};

tests.full = [...tests.audio, ...tests.volume, ...tests.sounds, ...tests.spotify, ...tests.state];

if (process.argv.includes('--list')) {
    for (const [name, entries] of Object.entries(tests)) console.log(`${name}: ${entries.length} smoke(s)`);
    process.exit(0);
}
if (!tests[profile]) {
    console.error(`Unknown Audioflix smoke profile "${profile}". Choose: ${Object.keys(tests).join(', ')}`);
    process.exit(2);
}

const unique = [];
const seen = new Set();
for (const entry of tests[profile]) {
    const key = entry.join('\0');
    if (!seen.has(key)) { seen.add(key); unique.push(entry); }
}

let passed = 0;
for (const [runtime, relative] of unique) {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) {
        console.error(`MISSING :: ${relative}`);
        process.exit(2);
    }
    const command = runtime === 'python' ? (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) : process.execPath;
    console.log(`\n=== ${profile.toUpperCase()} :: ${relative} ===`);
    const result = spawnSync(command, [absolute], { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (result.error) {
        console.error(`FAILED TO START :: ${relative} :: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`FAIL :: ${relative} :: exit ${result.status}`);
        process.exit(result.status || 1);
    }
    passed += 1;
}

console.log(`\nAUDIOFLIX_AUDIO_SUITE_OK profile=${profile} passed=${passed}`);
