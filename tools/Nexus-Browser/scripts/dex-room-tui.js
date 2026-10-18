'use strict';
// Interactive room chat is a presentation client. It never dispatches a second
// agent turn, and verifies finals against the existing durable Dex receipt.
const readline = require('node:readline');

function formatRoom(result = {}) {
  if (!result.ok) return `${result.code || 'ROOM_ERROR'}: ${result.message || 'Room unavailable'}`;
  const bits = [result.roomName || result.roomId || 'Dex room'];
  if (result.busy) bits.push('busy');
  else bits.push('idle');
  if (result.recoveryPending) bits.push('recovery pending');
  if (result.tloMemberId) bits.push('TLO bound');
  if (result.machineSpaceId) bits.push('Machine Space attached');
  return bits.join(' · ');
}
function formatFinal(result = {}) {
  if (result.status === 'FINAL_RECEIPT_CONFIRMED' && result.response)
    return `TLO/Dex> ${result.response.text}`;
  return `${result.code || result.status || 'UNKNOWN'}: ${result.message || result.lastStopReason || 'Final receipt not confirmed'}`;
}
async function runTui(p, { tx, payload, id, input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, pollMs = 1200, timeoutMs = 90000 } = {}) {
  if (typeof tx !== 'function' || typeof payload !== 'function' || typeof id !== 'function')
    throw new TypeError('Dex TUI requires the established terminal operator client');
  const rl = readline.createInterface({ input, output, terminal: !!output.isTTY, prompt: 'Dex> ' });
  const receipts = new Map();
  const monitors = new Map();
  let latest = null, verbose = false, closed = false;
  const write = (message) => { if (closed) return; output.write(`\n${message}\n`); rl.prompt(true); };
  const fail = (error) => write(`! ${error.code || 'ERROR'}: ${error.message || error}`);
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
      let result = null;
      while (!closed && Date.now() < deadline) {
        try {
          result = await tx(payload({ ...p, command: 'check', requestId: id(), lookupId: requestId }));
          if (closed) return result;
          if (!result.ok || result.status === 'FINAL_RECEIPT_CONFIRMED') {
            remember(requestId, 'final', result);
            write(formatFinal(result));
            if (verbose) write(`Receipt /details:\n${JSON.stringify(receipts.get(requestId), null, 2)}`);
            return result;
          }
        } catch (error) {
          remember(requestId, 'error', { code: error.code || 'CHECK_FAILED', message: error.message });
          fail(error);
          return null; // uncertain: never send/retry the original message
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      if (!closed) write(`! No confirmed final receipt yet (${requestId}). Use /check or /details; don't resend.`);
      return result;
    })();
    monitors.set(requestId, pending);
    return pending;
  }
  output.write(`Dex room ${p.room} · auto-replies on · /status /history /check /wait /details /ids /quit\n`);
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/quit' || text === '/exit') break;
    try {
      if (text === '/help') {
        write('/status room state · /history recent messages · /check latest receipt · /wait await latest reply · /details [on|off] technical receipts · /ids request IDs · /quit');
      } else if (text === '/ids') {
        write([...receipts.keys()].join('\n') || 'No messages sent in this session.');
      } else if (text === '/details' || text === '/details on' || text === '/details off') {
        if (text.endsWith(' on')) verbose = true;
        if (text.endsWith(' off')) verbose = false;
        write(latest ? JSON.stringify(receipts.get(latest), null, 2) : `Detailed receipts ${verbose ? 'enabled' : 'hidden'}. No messages yet.`);
      } else if (text === '/status' || text === '/history') {
        const result = await tx(payload({ ...p, command: 'inspect', requestId: id(), limit: text === '/history' ? 15 : 3 }));
        if (text === '/status') write(formatRoom(result));
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
        if (!result.ok) write(`! ${result.code || 'SEND_BLOCKED'}: ${result.message || 'Send rejected'} (${requestId})`);
        else if (result.status === 'MESSAGE_COMMITTED_RELAY_ACCEPTED') {
          write(`· Sent. Waiting for the room reply…`);
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
module.exports = { runTui, formatRoom, formatFinal };
