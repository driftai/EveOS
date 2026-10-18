'use strict';
// A browser-initiated, fixed-command Windows terminal launcher. No shell input,
// provider control, model action, write grant or target mutation is accepted.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const ROOM = /^room-[A-Za-z0-9_-]{6,125}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
function shellLiteral(s) { return `'${String(s).replace(/'/g, "''")}'`; }
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
  const command = `& ${shellLiteral(nodeExe)} ${shellLiteral(script)} tui --room ${shellLiteral(decision.roomId)}`;
  const result = await new Promise(resolve => {
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', command], {
        cwd: path.dirname(script), detached: true, windowsHide: false, stdio: 'ignore', shell: false
      });
    } catch (error) {
      resolve({ ok: false, code: 'DEX_TUI_LAUNCH_FAILED', message: String(error.message).slice(0, 180) }); return;
    }
    child.once('error', error => resolve({ ok: false, code: 'DEX_TUI_LAUNCH_FAILED', message: String(error.message).slice(0, 180) }));
    child.once('spawn', () => { child.unref?.(); resolve({ ok: true, roomId: decision.roomId, launched: true }); });
  });
  return { type: 'dex_tui_launch_result', requestId, ...result };
}
module.exports = { authorize, shellLiteral, launchRoomTui };
