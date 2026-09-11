#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const registryPath = path.join(ROOT, 'config', 'eveos-ports.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const ports = registry?.ports || {};
const failures = [];

function check(condition, message) {
    if (!condition) failures.push(message);
}

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

check(Number(registry.schemaVersion) >= 1, 'registry schemaVersion is missing');
check(Object.keys(ports).length >= 10, 'registry unexpectedly contains too few services');

const byPort = new Map();
for (const [name, entry] of Object.entries(ports)) {
    const port = Number(entry?.port);
    check(/^[A-Z][A-Z0-9_]*_PORT$/.test(name), `invalid port key: ${name}`);
    check(Number.isInteger(port) && port >= 1 && port <= 65535, `invalid port for ${name}: ${entry?.port}`);
    check(typeof entry?.service === 'string' && entry.service.trim(), `missing service label for ${name}`);
    if (Number.isInteger(port)) {
        const owners = byPort.get(port) || [];
        owners.push(name);
        byPort.set(port, owners);
    }
}

for (const [port, owners] of byPort) {
    check(owners.length === 1, `port ${port} is assigned to multiple EveOS services: ${owners.join(', ')}`);
}

for (const required of [
    'EVEOS_WEB_PORT', 'WORLD_BOOK_PORT', 'PIANO_PLAYER_PORT',
    'GEMINI_CONTROL_PORT', 'GEMINI_WS_PORT', 'GEMINI_STATUS_PORT',
    'WATCHFUSION_PORT', 'LIGHTPANDA_BRIDGE_PORT', 'CAMOFOX_BRIDGE_PORT',
    'WIKIMEDIA_BRIDGE_PORT', 'POPUP_BRIDGE_PORT'
]) {
    check(Boolean(ports[required]), `required service is not registered: ${required}`);
}

const geminiWs = Number(ports.GEMINI_WS_PORT?.port);
const watchFusion = Number(ports.WATCHFUSION_PORT?.port);
check(geminiWs !== watchFusion, 'WatchFusion and Gemini Live must never share a port');

const batchAdapter = read('tools/batch/eveos-ports.bat');
check(batchAdapter.includes('config\\eveos-ports.json'), 'batch launchers are not sourcing the canonical registry');
check(!/set\s+"GEMINI_WS_PORT=\d+"/i.test(batchAdapter), 'batch adapter reintroduced a hard-coded Gemini port');
check(!/set\s+"WATCHFUSION_PORT=\d+"/i.test(batchAdapter), 'batch adapter reintroduced a hard-coded WatchFusion port');

const geminiMenu = read('tools/batch/server-menu.bat');
check(!/if not defined GEMINI_WS_PORT set "GEMINI_WS_PORT=\d+"/i.test(geminiMenu),
    'Gemini launcher reintroduced a literal WebSocket-port fallback');
check(!/if not defined GEMINI_STATUS_PORT set "GEMINI_STATUS_PORT=\d+"/i.test(geminiMenu),
    'Gemini launcher reintroduced a literal status-port fallback');
check(geminiMenu.includes('eveos-ports.bat') && geminiMenu.includes('if errorlevel 1 exit /b 1'),
    'Gemini launcher does not fail closed when the port registry cannot load');

const browserRegistry = read('js/modules/core/eveos-port-registry.js');
for (const [name, entry] of Object.entries(ports)) {
    check(new RegExp(`${name}\\s*:\\s*${Number(entry.port)}(?:\\D|$)`).test(browserRegistry),
        `browser port registry drifted from config/eveos-ports.json for ${name}`);
}

const localControl = read('js/modules/core/eveos-local-control.js');
check(localControl.includes("registryPort('GEMINI_CONTROL_PORT')") && localControl.includes('EveOSPortRegistry?.get?.'),
    'browser local-control client bypasses the canonical port registry');
check(!/DEFAULT_PORT\s*=\s*\d+/.test(localControl), 'browser local-control client reintroduced a literal fallback port');

const runtimeSensor = read('js/modules/features/watchfusion/watchfusion.runtime-sensing.js');
check(runtimeSensor.includes("EveOSPortRegistry?.get?.('WATCHFUSION_PORT'"),
    'WatchFusion browser runtime sensing bypasses the canonical port registry');

const pythonBootstrap = read('server_modules/__init__.py');
check(pythonBootstrap.includes('bootstrap_environment()'), 'Python server modules do not bootstrap the canonical registry');

const managedPythonPortConsumers = [
    ['server_modules/eveos_web_control.py', 'EVEOS_WEB_PORT'],
    ['server_modules/eveos_control_helper.py', 'GEMINI_CONTROL_PORT'],
    ['server_modules/gemini_control.py', 'GEMINI_WS_PORT'],
    ['server_modules/gemini_control.py', 'GEMINI_STATUS_PORT'],
    ['server_modules/world_book_control.py', 'WORLD_BOOK_PORT'],
    ['server_modules/piano_player_control.py', 'PIANO_PLAYER_PORT'],
    ['server_modules/watchfusion_control.py', 'WATCHFUSION_PORT']
];
for (const [relative, key] of managedPythonPortConsumers) {
    const text = read(relative);
    const registered = Number(ports[key]?.port);
    check(text.includes(`eveos_ports.service_port("${key}")`) || text.includes(`eveos_ports.service_port('${key}')`),
        `${relative} does not resolve ${key} through eveos_ports.service_port()`);
    check(!new RegExp(`\\b${registered}\\b`).test(text),
        `${relative} still embeds registered port ${registered} instead of the registry key ${key}`);
    check(!new RegExp(`os\\.environ\\.get\\(["']${key}["']\\)[^\\n]*\\bor\\s*\\d+`).test(text),
        `${relative} reintroduced an environment-or-literal fallback for ${key}`);
    check(!new RegExp(`_port_from_env\\(["']${key}["']\\s*,\\s*\\d+`).test(text),
        `${relative} reintroduced a helper literal fallback for ${key}`);
}

const controlHelper = read('server_modules/eveos_control_helper.py');
check(!/DEFAULT_PORT\s*=\s*\d+/.test(controlHelper),
    'EveOS control-plane entrypoint reintroduced a literal default port');

const watchControl = read('server_modules/watchfusion_control.py');
check(watchControl.includes('eveos_ports.service_port("WATCHFUSION_PORT")'), 'WatchFusion lifecycle bypasses the registry');

const watchConfig = read('tools/WatchFusion/src/server/config.js');
check(watchConfig.includes("registeredPort('WATCHFUSION_PORT')"), 'WatchFusion server does not resolve its default port from the registry');
check(!/process\.env\.PORT\s*\|\|\s*['"]\d+['"]/.test(watchConfig), 'WatchFusion server reintroduced a literal default port');

const launchFiles = [
    'tools/WatchFusion/WatchFusion.bat',
    'tools/WatchFusion/scripts/START-WATCHFUSION-LOCAL.bat',
    'tools/WatchFusion/scripts/START-WATCHFUSION-LAN.bat',
    'tools/WatchFusion/scripts/START-WATCHFUSION-REMOTE.bat',
    'tools/WatchFusion/scripts/REMOTE-TUNNEL.ps1',
    'tools/WatchFusion/scripts/ALLOW-LAN-FIREWALL.bat'
];
for (const relative of launchFiles) {
    const text = read(relative);
    check(!new RegExp(`(?:PORT|Port|localport)\\s*[=:]?\\s*${geminiWs}(?:\\D|$)`).test(text),
        `${relative} still embeds Gemini's registered port ${geminiWs}`);
    check(!new RegExp(`(?:PORT|Port|localport)\\s*[=:]?\\s*${watchFusion}(?:\\D|$)`).test(text),
        `${relative} hard-codes WatchFusion port ${watchFusion} instead of the registry variable`);
}
check(read('tools/WatchFusion/scripts/START-WATCHFUSION-LOCAL.bat').includes('%WATCHFUSION_PORT%'),
    'local WatchFusion launcher does not consume WATCHFUSION_PORT');
check(read('tools/WatchFusion/scripts/START-WATCHFUSION-LAN.bat').includes('%WATCHFUSION_PORT%'),
    'LAN WatchFusion launcher does not consume WATCHFUSION_PORT');
check(read('tools/WatchFusion/scripts/START-WATCHFUSION-REMOTE.bat').includes('-Port %WATCHFUSION_PORT%'),
    'remote WatchFusion launcher does not pass the registry port into the tunnel');

const python = process.platform === 'win32' ? 'python.exe' : 'python3';
const runtime = spawnSync(python, ['tools/smoke/eveos_port_registry_smoke.py'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
});
check(runtime.status === 0,
    `runtime collision smoke failed: ${(runtime.stderr || runtime.stdout || '').trim().slice(-1500)}`);

if (failures.length) {
    console.error(`EVEOS_PORT_REGISTRY_AUDIT_FAIL ${failures.length}`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`EVEOS_PORT_REGISTRY_AUDIT_OK ${Object.keys(ports).length} services, ${byPort.size} unique ports`);
