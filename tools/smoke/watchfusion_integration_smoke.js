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
    const setupRoutes = read('tools/WatchFusion/src/server/setup-routes.js');
    const setupClient = read('tools/WatchFusion/public/client/setup-health.js');
    const setupHtml = read('tools/WatchFusion/public/index.html');
    const innerCss = read('tools/WatchFusion/public/style.css');
    const staticFiles = read('tools/WatchFusion/src/server/static-files.js');
    const youtubeSetup = read('tools/WatchFusion/voxelvision/scripts/SETUP-YOUTUBE.ps1');
    const youtubeImport = read('tools/WatchFusion/voxelvision/youtube-import.js');
    const depthSession = read('tools/WatchFusion/voxelvision/public/js/depth-worker-session.js');
    const maskAssist = read('tools/WatchFusion/voxelvision/public/js/foreground-mask-assist.js');

    check(helper.includes('from . import watchfusion_control'), 'WF-CONTROL-IMPORT', 'control plane does not import WatchFusion lifecycle');
    check(helper.includes('"/api/watchfusion/status"'), 'WF-CONTROL-STATUS', 'WatchFusion status route is missing');
    check(helper.includes('"/api/watchfusion/start"') && helper.includes('watchfusion_control.start_server'), 'WF-CONTROL-START', 'WatchFusion start route is missing');
    check(helper.includes('"/api/watchfusion/stop"') && helper.includes('watchfusion_control.stop_server'), 'WF-CONTROL-STOP', 'WatchFusion stop route is missing');
    check(helper.includes('"/api/watchfusion/setup"') && helper.includes('watchfusion_control.setup_component'), 'WF-CONTROL-SETUP', 'fresh-clone core setup route is missing');
    check(helper.includes('("watchFusion", watchfusion_control.stop_server)'), 'WF-STOP-ALL', 'global EveOS stop does not include WatchFusion');

    check(control.includes('WATCHFUSION_PORT') && control.includes('9085'), 'WF-PORT', 'WatchFusion lifecycle does not own port 9085');
    check(control.includes('payload.get("app") != "WatchFusion"'), 'WF-IDENTITY', 'health check does not verify WatchFusion identity');
    check(control.includes('if verified:') && control.includes('for pid in _pids()'), 'WF-SAFE-STOP', 'stop path is not gated by verified service identity');
    check(control.includes('[npm, "ci", "--no-audit", "--no-fund"]'), 'WF-CORE-CI', 'fresh clone cannot repair locked WatchFusion dependencies');
    check(control.includes('setupAvailable') && control.includes('npmReady'), 'WF-CORE-STATUS', 'outer UI cannot distinguish repairable dependency state');
    check(control.includes('"onDemand": True') && control.includes('is never restored at EveOS boot'), 'WF-ON-DEMAND-LIFECYCLE', 'WatchFusion can still auto-restore a prior runtime session');
    check(control.includes('def start_server(*, persist: bool = False)') && control.includes('def stop_server(*, persist: bool = False)'), 'WF-NO-PERSIST-DEFAULT', 'ordinary WatchFusion start/stop still persists surprise boot state');
    check(control.includes('"components": components'), 'WF-OFFLINE-SETUP-STATUS', 'outer workspace cannot inspect components while WatchFusion is stopped');
    check(control.includes('eveos_console_prefs.headless_for("watchFusion")'), 'WF-CONSOLE', 'WatchFusion does not use its independent console preference');
    check(prefs.includes('"watchFusion"'), 'WF-CONSOLE-REGISTRY', 'WatchFusion is not registered in console preferences');

    check(manifest.includes('watchfusion/watchfusion.bootstrap.js') && manifest.includes('watchfusion/watchfusion.js'), 'WF-MANIFEST', 'WatchFusion feature scripts are not in the EveOS manifest');
    check(bootstrap.includes(".topbar-audioflix-btn") && bootstrap.includes("insertAdjacentElement('afterend'"), 'WF-HEADER', 'WatchFusion header button is not anchored beside Audioflix');
    check(ui.includes('Opening WatchFusion is presentation-only') && ui.includes('await refresh();'), 'WF-OPEN-ON-DEMAND', 'opening WatchFusion can still launch its runtime');
    check(!ui.includes('if (status?.dependenciesReady) await setRunning(true)'), 'WF-SETUP-NO-AUTOSTART', 'core dependency setup still starts WatchFusion automatically');
    check(ui.includes("DETACHED_WINDOW_NAME = 'eveWatchFusionWindow'") && ui.includes('function detach()'), 'WF-DETACH', 'WatchFusion does not have Matrix-style named-window detach');
    check(ui.includes('data-wf-action="detach"') && !ui.includes('Open separate'), 'WF-DETACH-UI', 'WatchFusion header still uses the old separate-window action');
    check(ui.includes('/api/watchfusion/setup') && ui.includes('Install WatchFusion Core'), 'WF-CORE-UI', 'outer workspace cannot repair a fresh clone');
    check(ui.includes('data-wf-components') && ui.includes('renderComponents'), 'WF-OFFLINE-HEALTH-UI', 'stopped WatchFusion does not expose setup health in EveOS');
    check(css.includes('var(--accent)') && css.includes('var(--bg-secondary)'), 'WF-THEME', 'WatchFusion shell does not consume EveOS theme tokens');
    check(css.includes('.watchfusion-components') && css.includes('width: 100%'), 'WF-WORKSPACE-SHELL', 'WatchFusion outer shell does not expose the full EveOS workspace/setup surface');

    check(setupRoutes.includes("parts[1] !== 'setup'") && setupRoutes.includes("parts[2] === 'install'"), 'WF-SETUP-API', 'WatchFusion setup API is not routed');
    check(setupRoutes.includes('isInstallerLocal') && setupRoutes.includes('trycloudflare') && setupRoutes.includes("'cf-ray'"), 'WF-SETUP-LOCAL-ONLY', 'install actions are not protected from tunnel callers');
    check(setupRoutes.includes("component === 'nuvio'") && setupRoutes.includes("component === 'voxel-youtube'"), 'WF-SETUP-ACTIONS', 'Nuvio/Voxel helper installers are missing');
    check(setupRoutes.includes('BritishWerewolf/IS-Net-Anime'), 'WF-MODEL-ID', 'Setup Health does not report the actual anime mask model');
    check(setupHtml.includes('id="setupHealthBtn"') && setupHtml.includes('id="setupHealthGrid"'), 'WF-SETUP-HTML', 'Setup Health panel is missing from WatchFusion');
    check(setupHtml.includes("get('eveos') === '1'") && setupHtml.includes("classList.add('eveos-embedded')"), 'WF-EMBEDDED-MODE', 'embedded WatchFusion cannot opt into EveOS-native layout geometry');
    check(setupHtml.includes('id="resolveTabBtn"') && setupHtml.includes('id="shortcutVoxelVisionBtn"') && setupHtml.includes('id="shortcutNuvioBtn"'), 'WF-MEDIA-TABS', 'Find Media/Nuvio/VoxelVision tabs were lost in the merger');
    check(innerCss.includes('html.eveos-embedded .grid') && innerCss.includes('max-width: none') && innerCss.includes('aspect-ratio: auto'), 'WF-EMBEDDED-SIZING', 'embedded WatchFusion still uses standalone max-width/aspect constraints');
    check(staticFiles.includes("'client/setup-health.js'") && staticFiles.includes("'client/voxelvision-adapter.js'") && staticFiles.includes("'client/media-player.js'"), 'WF-CLIENT-BUNDLE', 'Setup Health or core media adapters are missing from the integrated bundle');
    check(setupClient.includes("'/api/setup/status'") && setupClient.includes("'/api/setup/install'"), 'WF-SETUP-CLIENT', 'Setup Health UI is not connected to setup API');

    check(youtubeSetup.includes('yt-dlp.exe') && youtubeSetup.includes('ffmpeg.exe') && youtubeSetup.includes('ffprobe.exe'), 'WF-YOUTUBE-TOOLS', 'fresh YouTube installer does not provision current helpers');
    check(youtubeSetup.includes('$nodeMajor -ge 22') && youtubeSetup.includes('deno.exe'), 'WF-YOUTUBE-JS-RUNTIME', 'fresh YouTube installer does not prefer supported Node 22+ with Deno fallback');
    check(youtubeImport.includes('nodeMajor >= 22'), 'WF-YTDLP-EJS', 'VoxelVision still forces an unsupported old Node runtime into current yt-dlp');
    check(depthSession.includes('voxelvision.model-ready-v1') && depthSession.includes('readyAt'), 'WF-DEPTH-MODEL-STATUS', 'depth model readiness is not persisted for Setup Health');
    check(maskAssist.includes("current['anime-mask']") && maskAssist.includes('readyAt'), 'WF-MASK-MODEL-STATUS', 'anime mask readiness is not persisted for Setup Health');
}

function embeddedRuntime() {
    const packagePath = path.join(TOOL, 'package.json');
    if (!fs.existsSync(packagePath)) return { state: 'SKIP', reason: 'tools/WatchFusion has not been hydrated yet' };

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
