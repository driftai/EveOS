'use strict';
// Retry only provably read-only commands. Every mutating outcome retains its
// original ID and is UNKNOWN after lost transport; never create a new SEND.
const { randomUUID } = require('node:crypto');
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SAFE = new Set(['help', 'onboard', 'rooms', 'targets', 'status',
  'read_checkpoint', 'room_budget', 'room_log', 'tool_result_status', 'post_idle_status']);
const TRANSIENT = new Set(['DEX_UI_OFFLINE', 'DEX_CONTROL_TIMEOUT', 'DEX_CONTROL_BAD_ACTION']);
function newRequestId(id = null) {
  const value = id == null ? 'provider-control-cli-' + randomUUID() : String(id);
  if (!ID.test(value)) throw new Error('Specify a bounded --control-id without spaces.');
  return value;
}
function shouldRetryResult(result = {}, command = {}) {
  return SAFE.has(String(command.action || '').toLowerCase()) && TRANSIENT.has(result.code);
}
async function runWithRetry({
  source, command, attempts = 4, delayMs = 1400, runImpl, requestId
} = {}) {
  const id = newRequestId(requestId);
  if (typeof runImpl !== 'function') throw new TypeError('Dex control client is required.');
  const max = Math.max(1, Math.min(4, Number.isInteger(attempts) ? attempts : 1));
  for (let n = 0; n < max; n++) {
    let result;
    try { result = await runImpl({ source, command, requestId: id }); }
    catch {
      return { ok: false, code: 'DEX_CONTROL_OUTCOME_UNKNOWN',
        message: 'Network disconnected; inspect exact request ' + id + ' before another command. Do not replay an uncertain mutation.',
        dexRequestId: id, data: { commitState: 'unknown', deliveryState: 'unknown' } };
    }
    const response = { ...(result || {}), dexRequestId: result?.dexRequestId || id };
    if (response.ok || !shouldRetryResult(response, command) || n === max - 1) return response;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
  }
  throw new Error('Unreachable bounded retry state.');
}
module.exports = { SAFE, TRANSIENT, newRequestId, shouldRetryResult, runWithRetry };
