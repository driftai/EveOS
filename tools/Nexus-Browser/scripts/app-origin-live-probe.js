'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { urls } = require('../runtime-config');
const storage = require('./terminal-relay-storage');

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

async function run() {
  const selected = storage.readTargetSelection()?.target;
  if (!selected?.id || selected.providerId !== 'chatgpt-desktop') {
    throw Object.assign(new Error('Connect a verified ChatGPT App target in Base Mode first.'), {
      code: 'APP_ORIGIN_LIVE_TARGET_REQUIRED'
    });
  }
  const marker = option('--expect', `APP_ORIGIN_LIVE_${randomUUID().slice(0, 8)}_OK`);
  const prompt = option('--prompt', `Reply exactly with: ${marker}`);
  const contains = option('--contains').split('|').map((value) => value.trim()).filter(Boolean);
  const timeoutMs = Math.max(10000, Number(option('--timeout-ms', '120000')) || 120000);
  const recoveryAfterMs = Math.max(0, Number(option('--recover-after-ms', '15000')) || 0);
  const requestId = `app-origin-live-${randomUUID()}`;
  const startedAt = Date.now();
  const partialLengths = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(urls().websocket);
    let sent = false, accepted = 0, finals = 0, recoverySent = false, recovery = null, recoveryTimer = null;
    const timeout = setTimeout(() => finish(new Error('App-Origin live probe timed out.')), timeoutMs);

    function finish(error, result) {
      clearTimeout(timeout);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      try { ws.close(); } catch {}
      if (error) reject(error); else resolve(result);
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'app-origin-live-probe' }));
      ws.send(JSON.stringify({ type: 'select_app_target', targetId: selected.id }));
    });
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'app_target_selected' && !sent) {
        sent = true;
        ws.send(JSON.stringify({
          type: 'send_prompt', targetClassId: 'app-origin', targetId: selected.id,
          requestId, text: prompt
        }));
        if (recoveryAfterMs) recoveryTimer = setTimeout(() => {
          if (finals) return;
          recoverySent = true;
          ws.send(JSON.stringify({
            type: 'recover_app_target_busy', targetClassId: 'app-origin',
            targetId: selected.id, requestId
          }));
        }, recoveryAfterMs);
        return;
      }
      if (message.requestId !== requestId) return;
      if (message.type === 'prompt_accepted') accepted += 1;
      if (message.type === 'response_partial') partialLengths.push(String(message.text || '').length);
      if (message.type === 'app_target_busy_recovery') recovery = {
        recovered: message.recovered === true, reason: message.reason || null
      };
      if (message.type === 'error') {
        finish(Object.assign(new Error(message.message || 'App-Origin live probe failed.'), {
          code: message.code || 'APP_ORIGIN_LIVE_FAILED'
        }));
        return;
      }
      if (message.type !== 'response_final') return;
      finals += 1;
      const text = String(message.text || '').trim();
      const contentOk = contains.length
        ? contains.every((value) => text.split(value).length === 2)
        : text === marker;
      finish(null, {
        ok: contentOk && accepted === 1 && finals === 1,
        requestId, marker, contains, text, accepted, finals, recoverySent, recovery, partialLengths,
        elapsedMs: Date.now() - startedAt,
        timing: message.detail || message.transportTiming || message.timing || null
      });
    });
    ws.on('error', finish);
  });
}

if (require.main === module) {
  run().then((result) => {
    console.log(`APP_ORIGIN_LIVE_PROBE_${result.ok ? 'OK' : 'FAILED'} ${JSON.stringify(result)}`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    console.error(`APP_ORIGIN_LIVE_PROBE_ERROR ${error.code || 'ERROR'} ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, option };
