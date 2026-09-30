#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SEARCH_MONITOR_SERVICES, runWindowsBatchSync } from '../runtime/search-monitor-runtime.shared.mjs';

function requireCondition(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const profileSource = fs.readFileSync(path.join(ROOT, 'tools', 'smoke', 'eveos_profile_runner.mjs'), 'utf8');
const controlSource = fs.readFileSync(path.join(ROOT, 'server_modules', 'eveos_control_helper.py'), 'utf8');
const consolePrefsSource = fs.readFileSync(path.join(ROOT, 'server_modules', 'eveos_console_prefs.py'), 'utf8');
const controlBatchSource = fs.readFileSync(path.join(ROOT, 'tools', 'batch', 'start-eveos-control.bat'), 'utf8');
const sharedRuntimeSource = fs.readFileSync(path.join(ROOT, 'tools', 'runtime', 'search-monitor-runtime.shared.mjs'), 'utf8');
const cli = path.join(ROOT, 'tools', 'runtime', 'search-monitor-runtime.mjs');
const runtimeCliSource = fs.readFileSync(cli, 'utf8');
const liveBrowserSource = fs.readFileSync(
  path.join(ROOT, 'tools', 'smoke', 'search_monitor_live_browser_smoke.js'),
  'utf8'
);
const liveRuntimeSource = fs.readFileSync(
  path.join(ROOT, 'tools', 'smoke', 'search_monitor_live_runtime_smoke.mjs'),
  'utf8'
);
const sessionPath = path.join(ROOT, 'data', 'runtime', 'search-monitor-runtime-session.json');
const sessionBefore = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8') : null;

const requiredServices = ['web', 'localMoe', 'nexusBrowser', 'gemini'];
for (const name of requiredServices) {
  requireCondition(!!SEARCH_MONITOR_SERVICES[name], `runtime harness is missing service definition: ${name}`);
  requireCondition(/^\/api\//.test(SEARCH_MONITOR_SERVICES[name].statusPath), `${name} status path is not control-plane backed`);
  requireCondition(/^\/api\//.test(SEARCH_MONITOR_SERVICES[name].startPath), `${name} start path is not control-plane backed`);
  requireCondition(/^\/api\//.test(SEARCH_MONITOR_SERVICES[name].stopPath), `${name} stop path is not control-plane backed`);
}

requireCondition(
  SEARCH_MONITOR_SERVICES.web.stopPath.includes('/api/eveos-server/stop-web'),
  'Search Monitor stop would use Global Stop instead of scoped web shutdown'
);
requireCondition(
  runtimeCliSource.includes('ensureLocalModelRuntime'),
  'live runtime sequence no longer explicitly starts the Local MoE model stage'
);
requireCondition(
  runtimeCliSource.indexOf('await ensureLocalModelRuntime') < runtimeCliSource.indexOf('tlo = await waitForTloReady(modelTimeoutMs)'),
  'TLO readiness wait can run before the explicit Local MoE model start stage'
);
requireCondition(
  runtimeCliSource.includes('spawnSync(process.execPath')
    && runtimeCliSource.includes('search_monitor_live_runtime_smoke.mjs')
    && runtimeCliSource.includes('search_monitor_live_browser_smoke.js'),
  'live qualification no longer launches its Node smoke stages directly'
);
requireCondition(
  !runtimeCliSource.includes("spawnSync(npm, ['run', '--silent', 'smoke:search-monitor-live']"),
  'live qualification reintroduced the opaque Windows npm.cmd shim'
);
requireCondition(
  runtimeCliSource.includes("spawnSync(process.execPath, [npmCli, '--prefix'")
    && runtimeCliSource.includes("'run', '--silent', 'extension:reload'"),
  'extension reload no longer launches npm through its Node entrypoint'
);
requireCondition(
  runtimeCliSource.includes('spawnError')
    && runtimeCliSource.includes('qualificationFailure')
    && runtimeCliSource.includes('stageResults'),
  'live qualification no longer records stage-specific spawn diagnostics'
);
requireCondition(
  liveBrowserSource.includes("const FILE_URL = 'file:///")
    && liveBrowserSource.includes("'file-origin'")
    && liveBrowserSource.includes('requiredRuntimeRequest')
    && liveBrowserSource.includes('File-origin TLO chat did not complete cleanly'),
  'live Search Monitor browser qualification no longer covers the real file-origin entrypoint and chat path'
);
requireCondition(
  liveBrowserSource.includes('completedStreamAbortIsBenign')
    && liveBrowserSource.includes('ERR_ABORTED')
    && liveBrowserSource.includes('strictFileFailures'),
  'file-origin TLO smoke no longer distinguishes a completed SSE close abort from a real runtime failure'
);
requireCondition(
  liveBrowserSource.includes('Nexus Browser iframe did not load')
    && liveBrowserSource.includes('embeddedNexus'),
  'live Search Monitor browser qualification no longer proves the embedded Nexus workspace'
);
requireCondition(
  liveRuntimeSource.includes('waitForNexusInventoryStable')
    && liveRuntimeSource.includes('extensionSessions')
    && liveRuntimeSource.includes('Nexus public provider count drifted from authoritative extension inventory'),
  'live runtime qualification no longer guards authoritative Nexus provider inventory stability'
);
requireCondition(
  runtimeCliSource.includes('function scopeQualificationFailure(')
    && runtimeCliSource.includes('FAILURE_LOG_TAIL')
    && runtimeCliSource.includes('FAILURE_SCOPE_SNAPSHOT'),
  'live qualification no longer prints a single-terminal scoped failure bundle'
);
requireCondition(
  runtimeCliSource.indexOf("const snapshot = await runtimeSnapshot({") < runtimeCliSource.indexOf("stopped.push(await stopModelRuntimeForFailure())"),
  'failure scoping no longer captures evidence before stopping the attributable component'
);
requireCondition(
  runtimeCliSource.includes('/api/runtime/stop')
    && runtimeCliSource.includes('FreeToken/Prism child stopped; Harness left running.'),
  'generation failure scoping no longer stops only the model child'
);
requireCondition(
  runtimeCliSource.includes("sessionOwns(name)")
    && runtimeCliSource.includes("not session-owned"),
  'failure scoping lost session ownership protection'
);
requireCondition(
  runtimeCliSource.includes('all participating servers are healthy; preserving them for a UI/assertion failure'),
  'browser failure scoping no longer preserves healthy services'
);
requireCondition(
  consolePrefsSource.includes('DEFAULT_HEADLESS = False'),
  'EveOS terminal preference default is no longer explicitly headed'
);
requireCondition(
  !controlBatchSource.includes(' /min "'),
  'Local Control launcher still starts minimized instead of a normal headed terminal'
);
requireCondition(
  sharedRuntimeSource.includes("['/d', '/c', 'call', batchPath, ...args]"),
  'Windows batch invocation no longer passes call and the quoted path as separate argv pieces'
);
requireCondition(
  sharedRuntimeSource.includes("body: { service: 'default', headless: false }"),
  'Search Monitor runtime no longer forces the global terminal default to headed'
);
requireCondition(
  sharedRuntimeSource.includes('body: { service: service.key, headless: false }'),
  'Search Monitor runtime no longer forces each spawned service terminal to headed'
);
requireCondition(
  !sharedRuntimeSource.includes('const overview = await requestJson(`${CONTROL_BASE}/api/control-plane/consoles`)'),
  'runtime startup reintroduced the expensive cold full-console overview probe'
);
requireCondition(
  sharedRuntimeSource.includes('did not persist headed terminal preference'),
  'runtime startup no longer verifies headed preferences from the cheap POST response'
);
requireCondition(
  sharedRuntimeSource.includes('${method} ${target.pathname}${target.search} timed out after'),
  'runtime HTTP timeout errors no longer identify the exact request'
);
requireCondition(
  sharedRuntimeSource.includes('Local model startup failed:')
    && sharedRuntimeSource.includes('runtime_lifecycle'),
  'runtime qualification no longer fails fast on authoritative model startup failure'
);

const headedControllers = {
  web: ['server_modules/eveos_web_control.py', 'headless_mode()'],
  gemini: ['server_modules/gemini_control.py', 'headless_for("gemini")'],
  localMoe: ['server_modules/local_moe_control.py', 'headless_for("localMoe")'],
  worldBook: ['server_modules/world_book_control.py', 'headless_for("worldBook")'],
  bookmarkIntel: ['server_modules/bookmark_intel_control.py', 'headless_for("bookmarkIntel")'],
  piano: ['server_modules/piano_player_control.py', 'headless_for("piano")'],
  watchFusion: ['server_modules/watchfusion_control.py', 'headless_for("watchFusion")'],
  nexusBrowser: ['server_modules/nexus_browser_control.py', 'headless_for("nexusBrowser")'],
};
for (const [service, [relative, marker]] of Object.entries(headedControllers)) {
  const controller = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  requireCondition(controller.includes(marker), `${service} no longer uses the shared headed/headless terminal preference`);
  requireCondition(controller.includes('CREATE_NEW_CONSOLE'), `${service} has no headed Windows console launch path`);
}

const windowsRuntimeSource = fs.readFileSync(
  path.join(ROOT, 'tools', 'Local-MoE-Harness', 'app', 'services', 'runtime_lifecycle_windows.py'),
  'utf8'
);
const freeTokenLauncher = fs.readFileSync(
  path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'run-freetoken-windows.ps1'),
  'utf8'
);
const prismLauncher = fs.readFileSync(
  path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'run-prism-llama-windows.ps1'),
  'utf8'
);
const harnessControl = fs.readFileSync(
  path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'control-windows.ps1'),
  'utf8'
);
const harnessLauncher = fs.readFileSync(
  path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'run-harness-windows.ps1'),
  'utf8'
);
const harnessConfig = fs.readFileSync(
  path.join(ROOT, 'tools', 'Local-MoE-Harness', 'app', 'config.py'),
  'utf8'
);
requireCondition(
  windowsRuntimeSource.includes('CREATE_NEW_CONSOLE')
    && windowsRuntimeSource.includes('Get-Content -LiteralPath')
    && windowsRuntimeSource.includes('runtime-console.pid'),
  'Local MoE no longer exposes the model runtime through a dedicated headed console'
);
requireCondition(
  windowsRuntimeSource.includes('stdout=log_file')
    && windowsRuntimeSource.includes('stderr=asyncio.subprocess.STDOUT'),
  'Local MoE model engine no longer preserves the proven direct startup-log capture path'
);
requireCondition(
  windowsRuntimeSource.includes('LOCAL_MOE_HEADLESS') && windowsRuntimeSource.includes('EVEOS_HEADLESS'),
  'Local MoE model runtime lost its explicit-only headless override'
);
requireCondition(
  !freeTokenLauncher.includes('Tee-Object') && !prismLauncher.includes('Tee-Object'),
  'model launchers reintroduced a PowerShell output pipeline that can change runtime semantics'
);
requireCondition(
  harnessControl.includes('if ($Headless)') && harnessControl.includes('} else {'),
  'manual Local MoE control no longer defaults to a headed Harness window'
);
requireCondition(
  harnessLauncher.includes('LOCAL_MOE_RUNTIME_AUTOSTART = "0"')
    && harnessLauncher.includes('$EveManaged'),
  'EveOS-managed Harness launch no longer suppresses boot-time model autostart'
);
requireCondition(
  harnessConfig.includes('LOCAL_MOE_RUNTIME_AUTOSTART')
    && harnessConfig.includes('_environment_bool'),
  'Harness config no longer supports explicit runtime autostart override'
);

if (process.platform === 'win32') {
  const probeRoot = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || ROOT, 'EveOS Runtime Batch Probe-'));
  try {
    const probeBatch = path.join(probeRoot, 'quoted launcher probe.bat');
    fs.writeFileSync(probeBatch, '@echo off\r\necho EVEOS_BATCH_QUOTE_OK\r\nexit /b 0\r\n', 'utf8');
    const invoked = runWindowsBatchSync(probeBatch, {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, EVEOS_HEADLESS: '' },
    });
    requireCondition(
      invoked.status === 0 && String(invoked.stdout || '').includes('EVEOS_BATCH_QUOTE_OK'),
      `Windows batch path-with-spaces probe failed: ${invoked.stderr || invoked.stdout || invoked.error?.message || 'unknown error'}`
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

if (process.platform === 'win32') {
  const powershellScripts = [
    path.join(ROOT, 'tools', 'batch', 'start-eveos-control.bat'),
    path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'run-harness-windows.ps1'),
    path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'run-freetoken-windows.ps1'),
    path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'run-prism-llama-windows.ps1'),
    path.join(ROOT, 'tools', 'Local-MoE-Harness', 'scripts', 'control-windows.ps1'),
  ].filter((script) => script.toLowerCase().endsWith('.ps1'));
  for (const script of powershellScripts) {
    const escaped = script.replace(/'/g, "''");
    const command = [
      '$tokens = $null',
      '$errors = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
    ].join('; ');
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000
    });
    requireCondition(
      parsed.status === 0,
      `PowerShell launcher syntax failed for ${path.relative(ROOT, script)}: ${parsed.stderr || parsed.stdout || parsed.error?.message || 'unknown error'}`
    );
  }
}
requireCondition(controlSource.includes('"/api/eveos-server/stop-web"'), 'control plane is missing scoped EveOS web stop');
requireCondition(
  controlSource.includes('eveos_web_control.stop_server(port=_request_web_port(self))'),
  'scoped web stop does not delegate to verified EveOS web lifecycle control'
);

const scripts = packageJson.scripts || {};
for (const script of [
  'runtime:search-monitor:start',
  'runtime:search-monitor:status',
  'runtime:search-monitor:stop',
  'runtime:search-monitor:restart',
  'runtime:search-monitor:qualify',
  'runtime:search-monitor:extension-reload',
  'smoke:search-monitor-runtime-harness',
  'smoke:search-monitor-live'
]) {
  requireCondition(typeof scripts[script] === 'string' && scripts[script], `package script missing: ${script}`);
}

requireCondition(
  !String(scripts.verify || '').includes('smoke:search-monitor-live'),
  'live GPU/runtime qualification must never run from the normal verify gate'
);
requireCondition(
  !profileSource.includes("'smoke:search-monitor-live'"),
  'live GPU/runtime qualification leaked into deterministic profile runner'
);
requireCondition(
  String(scripts['smoke:search-monitor-live']).includes('search_monitor_live_runtime_smoke.mjs')
    && String(scripts['smoke:search-monitor-live']).includes('search_monitor_live_browser_smoke.js'),
  'live Search Monitor gate does not include both runtime generation and real-browser checks'
);

const plan = spawnSync(process.execPath, [cli, 'plan'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000
});
const output = [plan.stdout, plan.stderr].filter(Boolean).join('\n');
requireCondition(plan.status === 0, `runtime plan failed: ${output || plan.error?.message || 'unknown error'}`);
requireCondition(output.includes('SEARCH_MONITOR_RUNTIME_PLAN'), 'runtime plan marker missing');
requireCondition(output.includes('web -> localMoe -> nexusBrowser'), 'default runtime plan lost the core Search Monitor stack');
requireCondition(output.includes('TEARDOWN none'), 'runtime plan no longer promises explicit-only teardown');

const sessionAfter = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8') : null;
requireCondition(sessionAfter === sessionBefore, 'runtime plan mutated the persistent runtime session');

for (const relative of [
  'tools/smoke/search_monitor_live_runtime_smoke.mjs',
  'tools/smoke/search_monitor_live_browser_smoke.js',
  'tools/runtime/search-monitor-runtime.shared.mjs',
  'tools/runtime/search-monitor-runtime.mjs'
]) {
  requireCondition(fs.existsSync(path.join(ROOT, relative)), `runtime qualification file missing: ${relative}`);
}

console.log('SEARCH_MONITOR_RUNTIME_HARNESS_SMOKE_OK');
