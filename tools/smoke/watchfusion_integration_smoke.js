#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'WatchFusion');
const security = process.argv.includes('--security');
const failures = [];
const checks = [];

function check(condition, id, detail) {
    if (condition) checks.push(id);
    else failures.push(`${id}: ${detail}`);
}

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function sourceContract() {
    const helper = read('server_modules/eveos_control_helper.py');
    const control = read('server_modules/watchfusion_control.py');
    const prefs = read('server_modules/eveos_console_prefs.py');
    const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');
    const bootstrap = read('js/modules/features/watchfusion/watchfusion.bootstrap.js');
    const ui = read('js/modules/features/watchfusion/watchfusion.js');
    const css = read('css/modules/watchfusion.css');

    check(helper.includes('from . import watchfusion_control'), 'WF-CONTROL-IMPORT', 'control plane does not import WatchFusion lifecycle');
    check(helper.includes('"/api/watchfusion/status"'), 'WF-CONTROL-STATUS', 'WatchFusion status route is missing');
    check(helper.includes('"/api/watchfusion/start"') && helper.includes('watchfusion_control.start_server'), 'WF-CONTROL-START', 'WatchFusion start route is missing');
    check(helper.includes('"/api/watchfusion/stop"') && helper.includes('watchfusion_control.stop_server'), 'WF-CONTROL-STOP', 'WatchFusion stop route is missing');
    check(helper.includes('watchfusion_control.restore_desired_state_async()'), 'WF-CONTROL-RESTORE', 'desired WatchFusion state is not restored');
    check(helper.includes('("watchFusion", watchfusion_control.stop_server)'), 'WF-STOP-ALL', 'global EveOS stop does not include WatchFusion');

    check(control.includes('WATCHFUSION_PORT') && control.includes('9085'), 'WF-PORT', 'WatchFusion lifecycle does not own port 9085');
    check(control.includes('payload.get("app") != "WatchFusion"'), 'WF-IDENTITY', 'health check does not verify WatchFusion identity');
    check(control.includes('if verified:') && control.includes('for pid in _pids()'), 'WF-SAFE-STOP', 'stop path is not gated by verified service identity');
    check(control.includes('tools" / "WatchFusion"') && control.includes('server.js'), 'WF-ENTRY', 'integrated tool entry path is wrong');
    check(control.includes('eveos_console_prefs.headless_for("watchFusion")'), 'WF-CONSOLE', 'WatchFusion does not use its independent console preference');
    check(prefs.includes('"watchFusion"'), 'WF-CONSOLE-REGISTRY', 'WatchFusion is not registered in console preferences');

    check(manifest.includes('watchfusion/watchfusion.bootstrap.js') && manifest.includes('watchfusion/watchfusion.js'), 'WF-MANIFEST', 'WatchFusion feature scripts are not in the EveOS manifest');
    check(bootstrap.includes(".topbar-audioflix-btn") && bootstrap.includes("insertAdjacentElement('afterend'"), 'WF-HEADER', 'WatchFusion header button is not anchored beside Audioflix');
    check(ui.includes('window.EveWatchFusion') && ui.includes('/api/watchfusion/status'), 'WF-UI', 'WatchFusion workspace is not bound to shared lifecycle status');
    check(css.includes('var(--accent)') && css.includes('var(--bg-secondary)'), 'WF-THEME', 'WatchFusion shell does not consume EveOS theme tokens');
}

function embeddedRuntime() {
    const packagePath = path.join(TOOL, 'package.json');
    if (!fs.existsSync(packagePath)) {
        return { state: 'SKIP', reason: 'tools/WatchFusion has not been hydrated yet' };
    }

    const serverPath = path.join(TOOL, 'server.js');
    const healthPath = path.join(TOOL, 'src', 'server', 'system-routes.js');
    check(fs.existsSync(serverPath), 'WF-RUNTIME-SERVER', 'hydrated WatchFusion is missing server.js');
    check(fs.existsSync(healthPath), 'WF-RUNTIME-HEALTH', 'hydrated WatchFusion is missing its system health route');
    if (fs.existsSync(healthPath)) {
        const health = fs.readFileSync(healthPath, 'utf8');
        check(health.includes("app: 'WatchFusion'") && health.includes("parts[1] === 'health'"), 'WF-RUNTIME-IDENTITY', 'runtime health identity changed');
    }

    const depsReady = fs.existsSync(path.join(TOOL, 'node_modules', 'ws'))
        && fs.existsSync(path.join(TOOL, 'node_modules', 'hls.js'));
    if (!depsReady) return { state: 'SKIP', reason: 'WatchFusion is hydrated but npm ci has not been run' };

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const script = security ? 'test:security' : 'test:smoke';
    const result = spawnSync(npm, ['run', '--silent', script], {
        cwd: TOOL,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
        maxBuffer: 3 * 1024 * 1024
    });
    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        failures.push(`WF-RUNTIME-${security ? 'SECURITY' : 'SMOKE'}: nested ${script} failed\n${output.slice(-5000)}`);
        return { state: 'FAIL', reason: script };
    }
    return { state: 'PASS', reason: script };
}

sourceContract();
const runtime = embeddedRuntime();

if (failures.length) {
    console.error(`WATCHFUSION INTEGRATION: PASS ${checks.length} | FAIL ${failures.length} | RUNTIME ${runtime.state}`);
    failures.slice(0, 20).forEach((failure) => console.error(`[FAIL] ${failure}`));
    process.exit(1);
}

console.log(`WATCHFUSION INTEGRATION: PASS ${checks.length} | FAIL 0 | RUNTIME ${runtime.state}${runtime.reason ? ` (${runtime.reason})` : ''}`);
