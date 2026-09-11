#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const registryPath = path.join(ROOT, 'config', 'eveos-ports.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const ports = registry?.ports || {};
const failures = [];

function check(condition, message) {
    if (!condition) failures.push(message);
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

const batchAdapter = fs.readFileSync(path.join(ROOT, 'tools', 'batch', 'eveos-ports.bat'), 'utf8');
check(batchAdapter.includes('config\\eveos-ports.json'), 'batch launchers are not sourcing the canonical registry');
check(!/set\s+"GEMINI_WS_PORT=\d+"/i.test(batchAdapter), 'batch adapter reintroduced a hard-coded Gemini port');
check(!/set\s+"WATCHFUSION_PORT=\d+"/i.test(batchAdapter), 'batch adapter reintroduced a hard-coded WatchFusion port');

const pythonBootstrap = fs.readFileSync(path.join(ROOT, 'server_modules', '__init__.py'), 'utf8');
check(pythonBootstrap.includes('bootstrap_environment()'), 'Python server modules do not bootstrap the canonical registry');

const watchConfig = fs.readFileSync(path.join(ROOT, 'tools', 'WatchFusion', 'src', 'server', 'config.js'), 'utf8');
check(watchConfig.includes("registeredPort('WATCHFUSION_PORT')"), 'WatchFusion server does not resolve its default port from the registry');
check(!/process\.env\.PORT\s*\|\|\s*['"]\d+['"]/.test(watchConfig), 'WatchFusion server reintroduced a literal default port');

if (failures.length) {
    console.error(`EVEOS_PORT_REGISTRY_AUDIT_FAIL ${failures.length}`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`EVEOS_PORT_REGISTRY_AUDIT_OK ${Object.keys(ports).length} services, ${byPort.size} unique ports`);
