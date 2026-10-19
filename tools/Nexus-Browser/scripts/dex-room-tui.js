'use strict';
// Interactive room chat is a presentation client. It never dispatches a second
// agent turn, and verifies finals against the existing durable Dex receipt.
const readline = require('node:readline');

const safeDiagnostic = (value, limit = 320) => String(value ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, limit);
const isDexError = m => m?.senderKind === 'system' && m?.senderName === 'Dex'
  && /^[^:\n]{1,80}:\s+[A-Z][A-Z0-9_]+:/.test(String(m.text || ''));
function formatRecentErrors(result = {}) {
  if (!result.ok) return `${safeDiagnostic(result.code || 'ROOM_ERROR')}: ${safeDiagnostic(result.message)}`;
  const recent = (result.messages || []).filter(isDexError).slice(-5);
  return recent.length ? recent.map(m => `! Room error (not proof for this request)${m.at ? ` @ ${safeDiagnostic(m.at, 48)}` : ''}: ${safeDiagnostic(m.text, 1000)}`).join('\n')
    : 'No Dex relay errors among the most recent inspected messages.';
}
function formatRoom(result = {}) {
  if (!result.ok) return `${result.code || 'ROOM_ERROR'}: ${result.message || 'Room unavailable'}`;
  const bits = [result.roomName || result.roomId || 'Dex room'];
  if (result.busy) bits.push('busy');
  else bits.push('idle');
  if (result.recoveryPending) bits.push('recovery pending');
  if (result.tloMemberId) bits.push('TLO bound');
  if (result.machineSpaceId) bits.push(result.machineSpaceLive === false ? 'Machine Space terminal offline' : 'Machine Space attached');
  if (result.lastStopReason && /error|fail|disconnect|timeout/i.test(result.lastStopReason)) bits.push('last stop: ' + safeDiagnostic(result.lastStopReason));
  return bits.join(' · ');
}
function formatFinal(result = {}) {
  if (result.status === 'FINAL_RECEIPT_CONFIRMED' && result.response)
    return `TLO/Dex> ${result.response.text}`;
  if (result.status === 'TURN_FAILED')
    return `! ${safeDiagnostic(result.code || 'DEX_RELAY_FAILED')}: ${safeDiagnostic(result.message || 'Dex turn failed.', 1000)} (request ${safeDiagnostic(result.requestId || 'unknown', 128)})`;
  if (result.status === 'TURN_OUTCOME_UNKNOWN')
    return `! Outcome unknown (${result.requestId || 'request'}): ${result.message || 'Inspect before retrying.'}`;
  return `${result.code || result.status || 'UNKNOWN'}: ${result.message || 'Final receipt not confirmed'}`;
}
async function runTui(p, { tx, payload, id, input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, pollMs = 700, timeoutMs = 195000 } = {}) {
  if (typeof tx !== 'function' || typeof payload !== 'function' || typeof id !== 'function')
    throw new TypeError('Dex TUI requires the established terminal operator client');
  const rl = readline.createInterface({ input, output, terminal: !!output.isTTY, prompt: 'Dex> ' });
  const receipts = new Map();
  const monitors = new Map();
  let latest = null, verbose = false, closed = false;
  const write = (message) => { if (closed) return; output.write(`\n${message}\n`); rl.prompt(true); };
  const fail = (error) => write(`! ${error.code || 'ERROR'}: ${error.message || error}`);
  const safePreview = value => String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g, '').slice(0, 1800);
  function remember(requestId, section, value) {
    const current = receipts.get(requestId) || { requestId };
    current[section] = value;
    receipts.set(requestId, current);
    while (receipts.size > 20) receipts.delete(receipts.keys().next().value);
  }
  function monitor(requestId) {
    if (monitors.has(requestId)) return monitors.get(requestId);
    const pending = (async () => {
      const deadline = Date.now() + timeoutMs;
      let result = null, lastProgress = '', lastPartial = '', lastUpdate = 0, roomErrorNoted = false;
      const started = Date.now();
      while (!closed && Date.now() < deadline) {
        try {
          result = await tx(payload({ ...p, command: 'check', requestId: id(), lookupId: requestId }));
          if (closed) return result;
          const terminal = !result.ok || ['FINAL_RECEIPT_CONFIRMED', 'TURN_FAILED', 'TURN_OUTCOME_UNKNOWN'].includes(result.status);
          if (terminal) {
            remember(requestId, 'final', result);
            write(formatFinal(result));
            if (verbose) write(`Receipt /details:\n${JSON.stringify(receipts.get(requestId), null, 2)}`);
            return result;
          }
          // A room-level stop is useful diagnostic evidence, not proof of this
          // specific request. Keep the original request ID and never replay.
          if (!roomErrorNoted && result.status === 'AWAITING_REPLY_OR_RECOVERY'
              && result.progress === 'not-active' && !result.relayActive && !result.recoveryPending
              && /error|fail|disconnect|timeout/i.test(String(result.lastStopReason || ''))) {
            roomErrorNoted = true;
            write(`! Room reports ${safeDiagnostic(result.lastStopReason)}; exact request ${requestId} is NOT confirmed failed or completed. Use /errors and /check. Do not resend.`);
            try {
              const diagnostics = await tx(payload({ ...p, command: 'inspect', requestId: id(), limit: 20 }));
              if (!closed) write(formatRecentErrors(diagnostics));
            } catch (error) { if (!closed) write(`! Room diagnostics unavailable: ${safeDiagnostic(error?.message || error)}`); }
          }
          if (result.progress && result.progress !== lastProgress) {
            lastProgress = result.progress;
            write(`· ${result.progress.replace(/-/g, ' ')} (${Math.round((Date.now() - started) / 1000)}s)`);
            lastUpdate = Date.now();
          }
          const partial = safePreview(result.partialText);
          if (partial && partial !== lastPartial) {
            const added = partial.startsWith(lastPartial) ? partial.slice(lastPartial.length) : partial;
            // Bound preview frequency. The final receipt remains authoritative.
            if ((Date.now() - lastUpdate > 1800 || !lastPartial) && added.length > 0) {
              write(`TLO (live preview)> ${partial}`);
              lastUpdate = Date.now();
            }
            lastPartial = partial;
          }
          if (Date.now() - lastUpdate > 15000) {
            write(`· Waiting for exact reply (${Math.round((Date.now() - started) / 1000)}s, ${result.progress || 'pending'})`);
            lastUpdate = Date.now();
          }
        } catch (error) {
          remember(requestId, 'error', { code: error.code || 'CHECK_FAILED', message: error.message });
          fail(error);
          return null; // uncertain: never send/retry the original message
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      if (!closed) write(`! Reply monitoring paused after ${Math.round(timeoutMs / 1000)}s (${requestId}). Outcome remains unconfirmed; use /check or /details. Do not resend.`);
      return result;
    })();
    monitors.set(requestId, pending);
    return pending;
  }
  output.write(`Dex room ${p.room} · auto-replies on · /status /history /errors /check /wait /details /ids /quit\n`);
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/quit' || text === '/exit') break;
    try {
      if (text === '/help') {
        write('/status room state and last error · /history recent messages · /errors latest Dex room errors · /check latest receipt · /wait await latest reply · /details [on|off] technical receipts · /ids request IDs · /quit');
      } else if (text === '/ids') {
        write([...receipts.keys()].join('\n') || 'No messages sent in this session.');
      } else if (text === '/details' || text === '/details on' || text === '/details off') {
        if (text.endsWith(' on')) verbose = true;
        if (text.endsWith(' off')) verbose = false;
        write(latest ? JSON.stringify(receipts.get(latest), null, 2) : `Detailed receipts ${verbose ? 'enabled' : 'hidden'}. No messages yet.`);
      } else if (text === '/status' || text === '/history' || text === '/errors') {
        const result = await tx(payload({ ...p, command: 'inspect', requestId: id(), limit: text === '/history' ? 15 : 20 }));
        if (text === '/status') { write(formatRoom(result)); if (result.ok) write(formatRecentErrors(result)); }
        else if (text === '/errors') write(formatRecentErrors(result));
        else write(!result.ok ? formatRoom(result) : (result.messages || []).map(m => `${m.senderName || m.senderKind}> ${m.text}`).join('\n') || 'No messages.');
      } else if (text === '/check' || text === '/wait') {
        if (!latest) throw new Error('No message in this TUI session; use CLI check with the exact request ID.');
        const result = text === '/wait' && monitors.has(latest) ? await monitors.get(latest)
          : await tx(payload({ ...p, command: 'check', requestId: id(), lookupId: latest }));
        if (text === '/check') { remember(latest, 'check', result); write(formatFinal(result)); }
        else if (verbose && result) write(JSON.stringify(result, null, 2));
      } else if (text.startsWith('/')) {
        write('Unknown command. Use /help.');
      } else {
        const requestId = id();
        const result = await tx(payload({ ...p, command: 'send', text, requestId }));
        remember(requestId, 'send', result);
        latest = requestId;
        if (!result.ok) {
          write(`! ${result.code || 'SEND_BLOCKED'}: ${result.message || 'Send rejected'} (${requestId})`);
          if (result.messageCommitted || result.retryForbidden) {
            write('· Message may already be committed. Monitoring this exact ID; do not resend.');
            void monitor(requestId);
          }
        }
        else if (result.status === 'MESSAGE_COMMITTED_RELAY_ACCEPTED') {
          write(`· Sent (request ${requestId}). Waiting for the room reply…`);
          void monitor(requestId);
        } else write(`· ${result.status || 'Accepted'} · /details for request ${requestId}`);
        if (verbose) write(JSON.stringify(receipts.get(requestId), null, 2));
      }
    } catch (error) { fail(error); }
    rl.prompt();
  }
  closed = true;
  rl.close();
}
module.exports = { runTui, formatRoom, formatFinal, formatRecentErrors };
