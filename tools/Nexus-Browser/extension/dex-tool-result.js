'use strict';
// One shared human-readable receipt for online tabs and local terminal CLI.
// Success means only the operation recorded by the server; a queued room send
// is NOT proof that its recipient received the message.
(() => {
  const MAX_DATA = 1400, MAX_MESSAGE = 420, MAX_REQUEST_ID = 128;
  function bounded(value, limit) {
    return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
      .replace(/\[\[DEX:/gi, '[DEX:').slice(0, limit);
  }
  function dataText(data) {
    if (data == null) return '';
    try { return bounded(JSON.stringify(data), MAX_DATA); }
    catch { return '{"unserializable":true}'; }
  }
  function status(result = {}) {
    const commit = result?.data?.commitState ?? null;
    const delivery = result?.data?.deliveryState ?? null;
    if (commit === 'committed' && delivery === 'queued')
      return 'Committed to durable FIFO; QUEUED, NOT DELIVERED.';
    if (commit === 'unknown' || delivery === 'unknown')
      return 'Outcome uncertain. Inspect the SAME request ID; do not replay.';
    if (commit === 'committed' && delivery)
      return 'Committed; reported delivery state: ' + bounded(delivery, 48)
        + '. This is not proof of a recipient response.';
    if (result.ok === true) return 'Control result committed by Dex; recipient response not implied.';
    return 'Command failed or could not be confirmed. Check its error code.';
  }
  function formatResult(result = {}, requestId = null) {
    const code = bounded(result.code || 'DEX_CONTROL_FAILED', 70);
    const state = result.ok === true ? 'OK' : 'ERROR ' + code;
    const id = requestId || result.dexRequestId || result.requestId || null;
    const data = dataText(result.data);
    const body = [
      '[DEX TOOL RESULT]',
      state + ': ' + bounded(result.message || 'No message.', MAX_MESSAGE),
      id ? 'Control request: ' + bounded(id, MAX_REQUEST_ID) : null,
      'Delivery: ' + status(result),
      data ? 'Data: ' + data : null,
      '',
      'If another Dex control action is needed, end your next reply with one trailing marker.',
      'Use [[DEX:CMD {"action":"help"}]] for the full room-admin command set.',
      'Common: [[DEX:CMD {"action":"status"}]] or [[DEX:CMD {"action":"send","text":"<message>","relay":true}]].',
      'Otherwise do not emit a Dex command.'
    ];
    return body.filter(v => v !== null).join('\n');
  }
  const api = { MAX_DATA, status, formatResult };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexToolResult = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
