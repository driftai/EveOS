#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const rootLauncher = path.join(ROOT, 'start-server.bat');
const helperNames = [
    'start-server.paths.bat',
    'start-server.browser.bat',
    'start-server.browse.bat',
    'start-server.instance.bat',
    'start-server.stack.bat'
];
const pythonLauncherNames = [
    'server-menu.bat',
    'start-camofox-bridge.bat',
    'start-eveos-control.bat',
    'start-eveos-port.bat',
    'start-lightpanda-bridge.bat',
    'start-popup-bridge.bat',
    'start-server.instance.bat',
    'start-server.stack.bat',
    'start-wikimedia-bridge.bat'
];

function read(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const rootSource = read(rootLauncher);
const helperSources = new Map();
for (const name of helperNames) {
    const filePath = path.join(ROOT, 'tools', 'batch', name);
    assert(fs.existsSync(filePath), 'Missing launcher helper: ' + name);
    const source = read(filePath);
    assert(source.includes('goto %_START_SERVER_'), 'Helper lacks dispatch facade: ' + name);
    helperSources.set(name, source);
}

const routeContracts = [
    ['start-server.paths.bat', [':ResolveMainDataPackPath', ':NormalizePortInput', ':TrackInstance']],
    ['start-server.browser.bat', [':RefreshBrowserFallbackStatus', ':EnsureLightpandaMonitor']],
    ['start-server.browse.bat', [':LaunchBatch', ':BrowseProjectBatchFiles']],
    ['start-server.instance.bat', [':LaunchEveInstance', ':LaunchEvePortOnly', ':StartAndVerifyEveServer', ':WaitForEveServer']],
    ['start-server.stack.bat', [':BootStandardStack', ':EnsureBridge', ':PortInUse']]
];
for (const [name, labels] of routeContracts) {
    const source = helperSources.get(name);
    for (const label of labels) {
        assert(source.includes(label), name + ' is missing ' + label);
    }
}

assert(rootSource.includes('call "%START_SERVER_INSTANCE_BAT%" :LaunchEveInstance %*'),
    'Root launcher does not delegate instance startup');
assert(rootSource.includes('call "%START_SERVER_STACK_BAT%" :BootStandardStack %*'),
    'Root launcher does not delegate full-stack startup');
assert(rootSource.split(/\r?\n/).length <= 450,
    'Root launcher exceeds the 450-line facade contract');

const instanceSource = helperSources.get('start-server.instance.bat');
assert(!/set\s+"LP_FLAG=/i.test(instanceSource),
    'Instance launcher must not construct Lightpanda command fragments in LP_FLAG');
assert(!/if\s+defined\s+LP_FLAG/i.test(instanceSource),
    'Instance launcher must not execute an incomplete IF DEFINED LP_FLAG command');
assert(instanceSource.includes('set "EVEOS_LIGHTPANDA_DISABLED=1"'),
    'Instance launcher does not express disabled Lightpanda through inherited environment state');
assert(instanceSource.includes('/api/status'),
    'Instance launcher does not probe EveOS readiness through /api/status');
assert(instanceSource.includes('eveos-local-server'),
    'Instance launcher readiness probe does not verify EveOS service identity');
assert(instanceSource.includes('call :StartAndVerifyEveServer "%INSTANCE_PORT%"'),
    'Instance launcher bypasses verified server startup');
assert(instanceSource.includes('if errorlevel 1 exit /b 1'),
    'Instance launcher does not stop after verified startup failure');
assert(instanceSource.includes('eveos-server-%_EVE_START_PORT%.log'),
    'Instance launcher does not preserve a startup log for failed minimized servers');

const firstVerifiedStart = instanceSource.indexOf('call :StartAndVerifyEveServer "%INSTANCE_PORT%"');
const firstTrack = instanceSource.indexOf('call "%START_SERVER_PATHS_BAT%" :TrackInstance');
assert(firstVerifiedStart >= 0 && firstTrack > firstVerifiedStart,
    'Instance launcher tracks the server before verified readiness');

const stackSource = helperSources.get('start-server.stack.bat');
for (const source of [instanceSource, stackSource]) {
    assert(source.includes('server/eveos-server-launch.py'),
        'Official EveOS launcher bypasses the explicit-host server adapter');
    assert(source.includes('select-exposure-mode.bat'),
        'Official EveOS launcher does not offer selective exposure');
    assert(source.includes('start-quick-tunnel.ps1'),
        'Official EveOS launcher lacks the authenticated Cloudflare router path');
}
assert(stackSource.includes('Internal control, Gemini and browser bridges remain localhost-only.'),
    'Standard stack does not preserve the localhost-only internal-service boundary');
assert(stackSource.includes('set "_EVE_BIND_HOST=127.0.0.1"'),
    'Standard stack no longer defaults the EveOS origin to loopback');
assert(instanceSource.includes('set "_EVE_BIND_HOST=127.0.0.1"'),
    'Instance launcher no longer defaults the EveOS origin to loopback');

const selectiveFiles = [
    'tools/batch/select-exposure-mode.bat',
    'tools/batch/eveos-secure-share.py',
    'tools/batch/start-quick-tunnel.ps1',
    'tools/batch/ensure-cloudflared.ps1',
    'tools/batch/set-exposure-state.ps1',
    'server/eveos-server-launch.py',
    'server_modules/eveos_exposure.py'
];
for (const relativePath of selectiveFiles) {
    assert(fs.existsSync(path.join(ROOT, relativePath)), 'Selective boot component missing: ' + relativePath);
}
const shareRouter = read(path.join(ROOT, 'tools', 'batch', 'eveos-secure-share.py'));
assert(shareRouter.includes('(\"127.0.0.1\", args.listen_port)'),
    'Cloudflare share router must itself remain loopback-only');
assert(shareRouter.includes('HttpOnly; Secure; SameSite=None; Partitioned'),
    'Cloudflare share router lost its authenticated cookie boundary');
assert(shareRouter.includes('strip_access(self.path)'),
    'Cloudflare share router does not strip access tokens before forwarding');
const cloudflaredBootstrap = read(path.join(ROOT, 'tools', 'batch', 'ensure-cloudflared.ps1'));
assert(cloudflaredBootstrap.includes('github.com/cloudflare/cloudflared/releases/latest/download/'),
    'Cloudflared bootstrap no longer uses the official Cloudflare release source');
assert(cloudflaredBootstrap.includes('--version'),
    'Cloudflared bootstrap does not self-check the downloaded executable');

const explicitServer = read(path.join(ROOT, 'server', 'eveos-server-launch.py'));
assert(explicitServer.includes('default="127.0.0.1"'),
    'Explicit EveOS server adapter no longer defaults to loopback');
assert(explicitServer.includes('{"127.0.0.1", "0.0.0.0"}'),
    'Explicit EveOS server adapter accepts an unexpected bind host');

const pianoLauncher = read(path.join(ROOT, 'tools', 'Piano-Auto-Player', 'start.bat'));
assert(pianoLauncher.includes('select-exposure-mode.bat'), 'Piano launcher lacks selective boot');
assert(pianoLauncher.includes('run.py --host 127.0.0.1'), 'Piano local/Cloudflare origin is not pinned to loopback');
assert(pianoLauncher.includes('run.py --host 0.0.0.0'), 'Piano LAN mode is missing its explicit bind');
assert(pianoLauncher.includes('start-quick-tunnel.ps1'), 'Piano Cloudflare mode bypasses the authenticated router');

const worldBookMain = read(path.join(ROOT, 'tools', 'World-Book', 'worldbook_runtime', 'layers', '90_main.py'));
const worldBookLauncher = read(path.join(ROOT, 'tools', 'World-Book', 'launch.ps1'));
assert(worldBookMain.includes('--host') && worldBookMain.includes('default="127.0.0.1"'),
    'World Book runtime no longer defaults to loopback');
assert(worldBookLauncher.includes("'cloudflare'") && worldBookLauncher.includes('start-quick-tunnel.ps1'),
    'World Book launcher lacks selective Cloudflare boot');

const watchfusionLocal = read(path.join(ROOT, 'tools', 'WatchFusion', 'scripts', 'START-WATCHFUSION-LOCAL.bat'));
const watchfusionLan = read(path.join(ROOT, 'tools', 'WatchFusion', 'scripts', 'START-WATCHFUSION-LAN.bat'));
const watchfusionRemote = read(path.join(ROOT, 'tools', 'WatchFusion', 'scripts', 'START-WATCHFUSION-REMOTE.bat'));
assert(!/start\s+""\s+"http/i.test(watchfusionLocal), 'WatchFusion Local must not open a duplicate browser tab');
assert(!/start\s+""\s+"http/i.test(watchfusionLan), 'WatchFusion LAN must not open a duplicate browser tab');
assert(watchfusionLan.includes('Get-NetIPConfiguration') && watchfusionLan.includes('IPv4DefaultGateway'),
    'WatchFusion LAN no longer resolves a preferred active LAN interface');
assert(watchfusionRemote.includes('ensure-cloudflared.ps1'),
    'WatchFusion Remote does not bootstrap a missing cloudflared executable');

const portsConfig = JSON.parse(read(path.join(ROOT, 'config', 'eveos-ports.json')));
for (const key of [
    'EVEOS_WEB_PORT', 'WORLD_BOOK_PORT', 'PIANO_PLAYER_PORT', 'WATCHFUSION_PORT',
    'GEMINI_WS_PORT', 'GEMINI_STATUS_PORT', 'GEMINI_CONTROL_PORT',
    'LIGHTPANDA_BRIDGE_PORT', 'CAMOFOX_BRIDGE_PORT', 'WIKIMEDIA_BRIDGE_PORT', 'POPUP_BRIDGE_PORT'
]) {
    assert(Number.isInteger(portsConfig.ports?.[key]?.port),
        'Canonical numeric port missing: ' + key);
}

if (process.platform === 'win32') {
    const probe = childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', [
        '/c', 'call tools\\batch\\eveos-ports.bat && set EVEOS_WEB_PORT && set GEMINI_WS_PORT'
    ], { encoding: 'utf8', cwd: ROOT });
    assert(probe.status === 0, 'eveos-ports.bat failed to export registered ports: ' + (probe.stderr || probe.stdout));
}

const pythonResolverPath = path.join(ROOT, 'tools', 'batch', 'eveos-python.bat');
assert(fs.existsSync(pythonResolverPath), 'Canonical Python resolver is missing');
const pythonResolverSource = read(pythonResolverPath);
assert(pythonResolverSource.includes('.venv\\Scripts\\python.exe'),
    'Python resolver does not prefer the documented project virtual environment');
assert(pythonResolverSource.includes('where python'),
    'Python resolver lacks the PATH fallback');

if (process.platform === 'win32') {
    const command = [
        'call tools\\batch\\eveos-python.bat >nul',
        'if errorlevel 1 exit /b 9',
        'if not defined EVEOS_PYTHON exit /b 10',
        '"!EVEOS_PYTHON!" --version >nul 2>nul'
    ].join(' & ');
    const probe = childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', [
        '/d', '/v:on', '/c', command
    ], {
        encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, EVEOS_PYTHON: 'C:\\missing\\eveos-python.exe' }
    });
    assert(probe.status === 0,
        'Python resolver live probe failed: ' + (probe.stderr || probe.stdout || probe.status));
}

for (const name of pythonLauncherNames) {
    const source = read(path.join(ROOT, 'tools', 'batch', name));
    assert(source.includes('eveos-python.bat'), name + ' bypasses the canonical Python resolver');
    assert(source.includes('EVEOS_PYTHON'), name + ' does not launch the resolved Python interpreter');
    assert(/if errorlevel 1/i.test(source), name + ' does not stop when Python resolution fails');
}

for (const relativePath of [
    'server/eveos-control-helper.py', 'server/python-server.py', 'server/eveos-server-launch.py',
    'server/bridges/popup-bridge.py', 'server/bridges/lightpanda-bridge.py', 'server/bridges/camofox-bridge.py'
]) {
    assert(fs.existsSync(path.join(ROOT, relativePath)), 'Launcher target missing: ' + relativePath);
}

for (const relativePath of [
    'tools/batch/eveos-control-protocol.bat',
    'tools/batch/install-eveos-control-protocol.bat',
    'tools/batch/install-eveos-control-protocol.ps1',
    'tools/batch/start-eveos-control.bat'
]) {
    assert(fs.existsSync(path.join(ROOT, relativePath)), 'Local-control bootstrap target missing: ' + relativePath);
}

const compatibilityControlSource = read(path.join(ROOT, 'tools', 'batch', 'start-gemini-control.bat'));
assert(compatibilityControlSource.includes('start-eveos-control.bat'),
    'Legacy Gemini helper launcher does not delegate to EveOS local control');
const geminiLauncherSource = read(path.join(ROOT, 'tools', 'batch', 'start-gemini.bat'));
assert(geminiLauncherSource.includes('start-eveos-control.bat'),
    'Gemini launcher does not ensure the general EveOS control plane');
assert(geminiLauncherSource.includes('server-menu.bat'),
    'Gemini launcher does not delegate backend lifecycle to the canonical menu');
const protocolSource = read(path.join(ROOT, 'tools', 'batch', 'eveos-control-protocol.bat'));
assert(!/%1|%2|%\*/i.test(protocolSource),
    'Protocol entrypoint must not forward URI-controlled arguments');
const controlLauncherSource = read(path.join(ROOT, 'tools', 'batch', 'start-eveos-control.bat'));
assert(controlLauncherSource.includes('/api/control-plane/health'),
    'Local-control launcher does not use the fast identity probe');
assert(controlLauncherSource.includes('--probe --timeout 30'),
    'Local-control launcher does not wait for verified readiness');
for (const stalePreference of ['piano-player-service.json', 'world-book-service.json', 'watchfusion-service.json']) {
    assert(controlLauncherSource.includes(stalePreference),
        'Local-control startup no longer clears stale on-demand service restore state: ' + stalePreference);
}

console.log('LAUNCHER_CONTRACT_SMOKE_OK', JSON.stringify({
    rootLines: rootSource.split(/\r?\n/).length,
    helpers: helperNames.length,
    pythonLaunchers: pythonLauncherNames.length,
    selectiveBootFiles: selectiveFiles.length
}));
