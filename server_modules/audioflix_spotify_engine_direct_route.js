'use strict';
// Helper-owned, native-process route. No browser capture or OS default changes.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function create({ profileDir, betaExecutable, note }) {
    let child = null, state = { active: false, state: 'idle', outputMode: 'direct' };
    let startPromise = null;
    const describe = () => ({ ...state, source: 'managed-spotify', outputMode: 'direct' });
    async function stop() {
        if (!child) { state = { active: false, state: 'idle' }; return describe(); }
        const proc = child;
        try { proc.stdin.write('STOP\n'); proc.stdin.end(); } catch {}
        const ended = await new Promise((resolve) => {
            if (proc.exitCode !== null) return resolve(true);
            let settled = false;
            const settle = value => { if (!settled) { settled = true; resolve(value); } };
            proc.once('exit', () => settle(true));
            const timer = setTimeout(() => settle(false), 10000);
            timer.unref?.();
        });
        if (!ended) throw new Error('Native route did not restore; do not start another audio route.');
        if (child === proc) child = null;
        state = { active: false, state: 'idle' };
        return describe();
    }
    async function start({ sessionId, deviceId, label = '' }) {
        if (!/^sd:\d+$/.test(String(deviceId || ''))) throw new Error('Exact native sd:N endpoint required.');
        if (child && state.active && state.endpoint === deviceId) return describe();
        if (child) await stop();
        if (process.platform !== 'win32') throw new Error('Direct Spotify output requires Windows.');
        if (!fs.existsSync(betaExecutable)) throw new Error('Edge Beta is unavailable; no fallback to Stable.');
        const worker = path.join(__dirname, 'audioflix_spotify_engine_direct_worker.py');
        if (!fs.existsSync(worker)) throw new Error('Native audio worker is missing.');
        const executable = String(process.env.EVEOS_SPOTIFY_PYTHON || 'python');
        const proc = spawn(executable, ['-u', '-B', worker, profileDir, betaExecutable, deviceId], {
            cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
        });
        child = proc;
        state = { active: false, state: 'starting', endpoint: deviceId, label, routeConfirmed: false };
        let buffer = '';
        let settled = false;
        let readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        const fail = error => { if (!settled) { settled = true; readyReject(error); } };
        const accept = msg => {
            if (child !== proc || !msg || typeof msg.kind !== 'string') return;
            if (msg.kind === 'ready') {
                state = { ...state, active: true, state: 'route-pending', endpoint: deviceId,
                    label: msg.endpoint || label, routeConfirmed: false };
                if (!settled) { settled = true; readyResolve(describe()); }
            } else if (msg.kind === 'routed') {
                state = { ...state, active: true, state: 'cable-routed', routeConfirmed: true,
                    sessionCount: msg.sessionCount, pids: msg.pids || [] };
            } else if (msg.kind === 'pending') {
                state = { ...state, state: 'route-pending', routeConfirmed: false };
            } else if (msg.kind === 'error') {
                state = { ...state, active: false, state: 'route-error', routeConfirmed: false,
                    message: String(msg.code || 'native-route-error').slice(0,100) };
                note('engine-native-route-error', state.message);
                fail(new Error(state.message));
            }
        };
        proc.stdout.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (buffer.length > 16384) { buffer = ''; fail(new Error('Native route output overflow.')); }
            while (buffer.includes('\n')) {
                const i = buffer.indexOf('\n'), line = buffer.slice(0,i); buffer = buffer.slice(i+1);
                try { accept(JSON.parse(line)); } catch { /* reject non-JSON diagnostics */ }
            }
        });
        proc.stderr.on('data', () => {}); // Do not echo sensitive process metadata.
        proc.once('error', error => { fail(error); state = { ...state, active:false, state:'route-error' }; });
        proc.once('exit', code => {
            fail(new Error(`Native route worker exited (code ${code}).`));
            state = { ...state, active: false, routeConfirmed: false, state: 'route-stopped' };
            if (child === proc) child = null;
        });
        let timer;
        try {
            return await Promise.race([ready, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Native route worker initialization timeout.')), 12000);
            })]);
        } finally { clearTimeout(timer); }
    }
    return { start, stop, status: describe };
}
module.exports = { create };
