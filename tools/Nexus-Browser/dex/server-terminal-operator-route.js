'use strict';
// Dedicated routing boundary for local user-origin Dex/TLO terminal controls.
// Other UI and provider-control commands are deliberately inaccessible.
const ALLOWED = new Set(['dex_terminal_bootstrap', 'dex_terminal_rooms', 'dex_terminal_inspect', 'dex_terminal_send', 'dex_terminal_room_send', 'dex_terminal_check', 'dex_terminal_viewer_standby']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function routeTerminalOperator(ws, msg, operator) {
  const requestId = msg?.requestId || null;
  if (!LOOPBACK.has(ws?.remoteAddress) || ws?.terminalOperatorOrigin)
    return { type:'error', requestId, code:'DEX_TERMINAL_LOCAL_ONLY', message:'Terminal operator requires direct loopback Node transport.' };
  if (!ALLOWED.has(msg?.type))
    return { type:'error', requestId, code:'DEX_TERMINAL_ACTION_DENIED', message:'Terminal operator has no other UI, provider or machine privileges.' };
  const result = operator.handle(msg);
  return { type:'dex_terminal_result', requestId, result };
}
module.exports = { routeTerminalOperator, ALLOWED, LOOPBACK };
