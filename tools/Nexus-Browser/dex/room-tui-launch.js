'use strict';
// A browser-initiated, fixed-command Windows terminal launcher. No shell input,
// provider control, model action, write grant or target mutation is accepted.
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOM = /^room-[A-Za-z0-9_-]{6,125}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
function shellLiteral(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function encodePowerShell(source) { return Buffer.from(String(source), 'utf16le').toString('base64'); }
function visibleLaunchSpec({ nodeExe, script, roomId }) {
  const targetCommand = `& ${shellLiteral(nodeExe)} ${shellLiteral(script)} tui --room ${shellLiteral(roomId)}`;
  const targetEncoded = encodePowerShell(targetCommand);
  const helperCommand = [
    "$ErrorActionPreference = 'Stop'",
    `$a = @('-NoLogo','-NoProfile','-NoExit','-EncodedCommand','${targetEncoded}')`,
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $a -WorkingDirectory ${shellLiteral(path.dirname(script))} -WindowStyle Normal -PassThru`,
    'Start-Sleep -Milliseconds 400',
    'if ($p.HasExited) { exit 2 }',
    '[Console]::Out.Write($p.Id)'
  ].join('; ');
  return {
    exe: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(helperCommand)],
    options: { cwd: path.dirname(script), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    targetCommand
  };
}
function launchVisible(spec, spawnImpl = spawn, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child, stdout = '', stderr = '', settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish({ ok: false, code: 'DEX_TUI_LAUNCH_TIMEOUT', message: 'PowerShell did not confirm a visible terminal.' }); }, timeoutMs);
    try { child = spawnImpl(spec.exe, spec.args, spec.options); }
    catch (error) { finish({ ok: false, code: 'DEX_TUI_LAUNCH_FAILED', message: String(error.message).slice(0, 180) }); return; }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ ok: false, code: 'DEX_TUI_LAUNCH_FAILED', message: String(error.message).slice(0, 180) }));
    child.once('close', (code) => {
      const pid = Number.parseInt(stdout.trim(), 10);
      finish(code === 0 && Number.isInteger(pid) && pid > 1
        ? { ok: true, launched: true, terminalPid: pid }
        : { ok: false, code: 'DEX_TUI_LAUNCH_FAILED', message: (stderr.trim() || `Visible terminal launcher exited ${code}.`).slice(0, 180) });
    });
  });
}
function authorize(ws, msg, snapshot, port, platform = process.platform) {
  if (msg?.type !== 'dex_launch_room_tui' || !REQUEST.test(String(msg.requestId || '')))
    return { ok: false, code: 'DEX_TUI_BAD_REQUEST', message: 'Invalid TUI launch request.' };
  if (ws?.role !== 'ui' || ws?.clientKind !== 'tui-launch' || !LOOPBACK.has(ws?.remoteAddress))
    return { ok: false, code: 'DEX_TUI_LOCAL_UI_ONLY', message: 'Launch is restricted to the local Nexus UI.' };
  const origin = ws.terminalOperatorOrigin;
  if (![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin))
    return { ok: false, code: 'DEX_TUI_ORIGIN_DENIED', message: 'Open Nexus from its own localhost URL.' };
  if (platform !== 'win32')
    return { ok: false, code: 'DEX_TUI_WINDOWS_ONLY', message: 'Use the terminal CLI directly on this platform.' };
  const roomId = String(msg.roomId || '');
  if (!ROOM.test(roomId) || !(snapshot?.rooms || []).some(r => r?.id === roomId))
    return { ok: false, code: 'DEX_TUI_ROOM_NOT_FOUND', message: 'Select an existing exact Dex room.' };
  return { ok: true, roomId };
}
async function launchRoomTui({ ws, msg, snapshot, port, platform = process.platform,
  spawnImpl = spawn, nodeExe = process.execPath,
  script = path.resolve(__dirname, '..', 'scripts', 'dex-room-terminal.js') } = {}) {
  const requestId = String(msg?.requestId || '');
  const decision = authorize(ws, msg, snapshot, port, platform);
  if (!decision.ok) return { type: 'dex_tui_launch_result', requestId, ...decision };
  const result = await launchVisible(visibleLaunchSpec({ nodeExe, script, roomId: decision.roomId }), spawnImpl);
  return { type: 'dex_tui_launch_result', requestId, roomId: decision.roomId, ...result };
}
module.exports = { authorize, shellLiteral, encodePowerShell, visibleLaunchSpec, launchVisible, launchRoomTui };
