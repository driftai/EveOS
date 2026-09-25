#!/usr/bin/env node
const { WebSocket } = require('ws');
const { urls } = require('../runtime-config');

const WS_URL = process.env.NEXUS_BROWSER_WS || process.env.BROWSER_AI_BRIDGE_WS || urls().websocket;

function usage(exitCode = 0) {
  console.log(`Dex provider-control CLI

Usage:
  node scripts/dexctl.js onboard --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js rooms --agy-pid 86660
  node scripts/dexctl.js targets --agy-pid 86660
  node scripts/dexctl.js create-room <name> --agy-pid 86660
  node scripts/dexctl.js rename-room <name> --agy-pid 86660 --room <id-or-name>
  node scripts/dexctl.js configure-room --agy-pid 86660 --room <id-or-name> [--max-turns N] [--context-messages N] [--auto-relay true|false] [--user-name <name>]
  node scripts/dexctl.js status --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js checkpoint <note> --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js read-checkpoint --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js rename-self <name> --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js relay-self <on|off> --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js use-room <id-or-name> --agy-pid 86660
  node scripts/dexctl.js clear-chat --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js delete-room <id-or-name> --agy-pid 86660
  node scripts/dexctl.js add-agent --room <id-or-name> --target-class <online-origin|local-origin> --target-id <id> [--name <name>] --agy-pid 86660
  node scripts/dexctl.js rename-agent --room <id-or-name> --member <id-or-name> --name <name> --agy-pid 86660
  node scripts/dexctl.js set-agent-relay <on|off> --room <id-or-name> --member <id-or-name> --agy-pid 86660
  node scripts/dexctl.js remove-agent --room <id-or-name> --member <id-or-name> --agy-pid 86660
  node scripts/dexctl.js stop-relay --room <id-or-name> --agy-pid 86660
  node scripts/dexctl.js continue-relay --room <id-or-name> [--turns N] --agy-pid 86660
  node scripts/dexctl.js send <message> --agy-pid 86660 [--room <id-or-name>] [--no-relay]
  node scripts/dexctl.js resume <message> --agy-pid 86660 [--room <id-or-name>]
  node scripts/dexctl.js report-post-idle <job-id> --agy-pid <existing-pid> --result success|failed --summary <evidence> [--doctor-ok true --global-idle true --adapter-revision 37 --new-session <id>]
  node scripts/dexctl.js post-idle-status --agy-pid <existing-pid> [--room <room-id>]
  node scripts/dexctl.js reload-extension
  node scripts/dexctl.js reload-tab <tab-id>
  node scripts/dexctl.js cleanup-disposable-rooms
  node scripts/dexctl.js resolve-passive-recovery --room <id-or-name> --request-id <dex-turn-id> [--reason <text>]

Source options:
  --agy-pid <pid>        Convenience for Existing Session Antigravity
  --target-id <id>       Exact Local-Origin target id
  --provider-id <id>     Defaults to local-antigravity-existing
  --provider-name <name> Defaults to Antigravity CLI

Dex provider commands can auto-wake the headed Dex UI; room state is durably mirrored on localhost.`);
  if (require.main === module) process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const commandName = args.shift();
  if (!commandName || commandName === '--help' || commandName === '-h') return { commandName: 'help-cli', options: {}, positionals: [] };
  const options = {};
  const positionals = [];
  while (args.length) {
    const token = args.shift();
    if (token === '--no-relay') { options.relay = false; continue; }
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (!args.length) throw new Error(`${token} requires a value.`);
      options[key] = args.shift();
      continue;
    }
    positionals.push(token);
  }
  return { commandName, options, positionals };
}

function sourceFrom(options, commandName = '') {
  let targetId = options.sourceTargetId || process.env.DEX_TARGET_ID || '';
  if (!targetId && options.agyPid) targetId = `local:antigravity-existing:${Number(options.agyPid)}`;
  if (!targetId && commandName !== 'add-agent') targetId = options.targetId || '';
  if (!targetId) throw new Error('Provide --agy-pid or --target-id (or DEX_TARGET_ID).');

  const providerId = options.sourceProviderId
    || (options.agyPid ? 'local-antigravity-existing' : (commandName === 'add-agent' ? 'local-antigravity-existing' : options.providerId))
    || process.env.DEX_PROVIDER_ID
    || 'local-antigravity-existing';
  const providerName = options.sourceProviderName
    || (options.agyPid ? 'Antigravity CLI' : (commandName === 'add-agent' ? 'Antigravity CLI' : options.providerName))
    || process.env.DEX_PROVIDER_NAME
    || 'Antigravity CLI';
  return { targetClassId: 'local-origin', targetId, providerId, providerName, title: providerName };
}

function commandFrom(parsed) {
  const { commandName, options, positionals } = parsed;
  if (commandName === 'onboard') return { action: 'onboard', ...(options.room ? { room: options.room } : {}) };
  if (commandName === 'rooms') return { action: 'rooms' };
  if (commandName === 'targets') return { action: 'targets' };
  if (commandName === 'create-room') {
    const name = positionals.join(' ').trim();
    if (!name) throw new Error('create-room requires a room name.');
    return { action: 'create_room', name };
  }
  if (commandName === 'rename-room') {
    const name = positionals.join(' ').trim();
    if (!options.room || !name) throw new Error('rename-room requires --room and a new name.');
    return { action: 'rename_room', room: options.room, name };
  }
  if (commandName === 'configure-room') {
    if (!options.room) throw new Error('configure-room requires --room.');
    const command = { action: 'configure_room', room: options.room };
    if (options.maxTurns != null) command.maxTurns = options.maxTurns;
    if (options.contextMessages != null) command.contextMessages = options.contextMessages;
    if (options.autoRelay != null) {
      const value = String(options.autoRelay).toLowerCase();
      if (!['true', 'false'].includes(value)) throw new Error('--auto-relay requires true or false.');
      command.autoRelay = value === 'true';
    }
    if (options.userName != null) command.userName = options.userName;
    return command;
  }
  if (commandName === 'status') return { action: 'status', ...(options.room ? { room: options.room } : {}) };
  if (commandName === 'checkpoint') {
    const note = positionals.join(' ').trim();
    if (!note) throw new Error('checkpoint requires note text.');
    return { action: 'checkpoint', note, ...(options.room ? { room: options.room } : {}) };
  }
  if (commandName === 'read-checkpoint') return { action: 'read_checkpoint', ...(options.room ? { room: options.room } : {}) };
  if (commandName === 'rename-self') {
    const name = positionals.join(' ').trim();
    if (!name) throw new Error('rename-self requires a name.');
    return { action: 'rename_self', name, ...(options.room ? { room: options.room } : {}) };
  }
  if (commandName === 'relay-self') {
    const value = String(positionals[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) throw new Error('relay-self requires on or off.');
    return { action: 'set_self_relay', enabled: value === 'on', ...(options.room ? { room: options.room } : {}) };
  }
  if (commandName === 'clear-chat') return { action: 'clear_chat', ...(options.room ? { room: options.room } : {}) };
  if (commandName === 'delete-room') {
    const room = positionals.join(' ').trim();
    if (!room) throw new Error('delete-room requires a room id or exact name.');
    return { action: 'delete_room', room };
  }
  if (commandName === 'use-room') {
    const room = positionals.join(' ').trim();
    if (!room) throw new Error('use-room requires a room id or exact name.');
    return { action: 'use_room', room };
  }
  if (commandName === 'add-agent') {
    if (!options.room) throw new Error('add-agent requires --room.');
    if (!options.targetClass) throw new Error('add-agent requires --target-class.');
    if (!options.targetId) throw new Error('add-agent requires --target-id.');
    return {
      action: 'add_agent',
      room: options.room,
      targetClassId: options.targetClass,
      targetId: options.targetId,
      ...(options.providerId ? { providerId: options.providerId } : {}),
      ...(options.name ? { name: options.name } : {})
    };
  }
  if (commandName === 'rename-agent') {
    if (!options.room || !options.member || !options.name) throw new Error('rename-agent requires --room, --member, and --name.');
    return { action: 'rename_agent', room: options.room, member: options.member, name: options.name };
  }
  if (commandName === 'set-agent-relay') {
    const value = String(positionals[0] || '').toLowerCase();
    if (!options.room || !options.member || !['on', 'off'].includes(value)) throw new Error('set-agent-relay requires on|off, --room, and --member.');
    return { action: 'set_agent_relay', room: options.room, member: options.member, enabled: value === 'on' };
  }
  if (commandName === 'remove-agent') {
    if (!options.room || !options.member) throw new Error('remove-agent requires --room and --member.');
    return { action: 'remove_agent', room: options.room, member: options.member };
  }
  if (commandName === 'stop-relay') {
    if (!options.room) throw new Error('stop-relay requires --room.');
    return { action: 'stop_relay', room: options.room };
  }
  if (commandName === 'continue-relay') {
    if (!options.room) throw new Error('continue-relay requires --room.');
    return { action: 'continue_relay', room: options.room, ...(options.turns ? { turns: options.turns } : {}) };
  }
  if (commandName === 'send' || commandName === 'resume') {
    const text = positionals.join(' ').trim();
    if (!text) throw new Error('send requires message text.');
    return { action: 'send', text, relay: commandName === 'resume' ? true : options.relay !== false, ...(options.room ? { room: options.room } : {}) };
  }
  if (commandName === 'report-post-idle') {
    const jobId = positionals[0];
    if (!jobId) throw new Error('report-post-idle requires the exact job id.');
    return { action: 'report_post_idle', jobId, result: options.result,
      summary: options.summary, doctorOk: options.doctorOk === 'true',
      globalIdle: options.globalIdle === 'true',
      adapterRevision: options.adapterRevision ? Number(options.adapterRevision) : null,
      newSession: options.newSession || null };
  }
  if (commandName === 'post-idle-status') return { action: 'post_idle_status', ...(options.room ? { room: options.room } : {}) };
  if (commandName === 'help') return { action: 'help' };
  throw new Error(`Unknown command: ${commandName}`);
}

function run({ source, command }) {
  return new Promise((resolve, reject) => {
    const requestId = `provider-control-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Timed out waiting for Nexus Browser provider-control result.'));
    }, 20000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'provider-control' }));
      ws.send(JSON.stringify({ type: 'provider_control_request', requestId, source, command }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type !== 'provider_control_result' || msg.requestId !== requestId) return;
      clearTimeout(timeout);
      ws.close();
      resolve(msg.result || { ok: false, message: 'No provider-control result.' });
    });
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function extensionConnectionEpoch(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(urls().diagnostics);
    if (!response.ok) return null;
    const data = await response.json();
    const sessions = data?.extensionSessions || {};
    const epochs = [sessions.primaryConnectionEpoch, ...(sessions.standby || []).map((item) => item.connectionEpoch)]
      .map(Number).filter(Number.isFinite);
    return epochs.length ? Math.max(...epochs) : 0;
  } catch { return null; }
}

async function runExtensionReload(timeoutMs = 20000, WebSocketImpl = WebSocket, fetchImpl = globalThis.fetch) {
  const baselineEpoch = await extensionConnectionEpoch(fetchImpl);
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(WS_URL);
    let sawDisconnect = false;
    let sawReloadAck = false;
    let commandSent = false;
    let epochTimer = null;
    const timeout = setTimeout(() => {
      clearInterval(epochTimer);
      try { ws.close(); } catch {}
      reject(new Error('Timed out waiting for the Nexus Browser extension to reload and reconnect.'));
    }, timeoutMs);

    function finish(result) {
      clearTimeout(timeout);
      clearInterval(epochTimer);
      try { ws.close(); } catch {}
      resolve(result);
    }

    function watchConnectionEpoch() {
      if (baselineEpoch == null || epochTimer) return;
      epochTimer = setInterval(async () => {
        const currentEpoch = await extensionConnectionEpoch(fetchImpl);
        if (sawReloadAck && currentEpoch != null && currentEpoch > baselineEpoch) {
          finish({ ok: true, action: 'reload_extension', message: 'Nexus Browser extension reloaded and reconnected.' });
        }
      }, 100);
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'provider-control' }));
      ws.send(JSON.stringify({ type: 'reload_extension' }));
      commandSent = true;
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'error' && msg.code === 'EXTENSION_OFFLINE') {
        return finish({ ok: false, code: msg.code, message: msg.message });
      }
      if (msg.type === 'reloading_extension') {
        sawReloadAck = true;
        watchConnectionEpoch();
        return;
      }
      if (msg.type !== 'bridge_status' || !commandSent) return;
      if (!msg.connected) {
        sawDisconnect = true;
        return;
      }
      if (sawDisconnect && msg.connected && baselineEpoch == null) {
        finish({ ok: true, action: 'reload_extension', message: 'Nexus Browser extension reloaded and reconnected.' });
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function runDisposableRoomCleanup(timeoutMs = 30000, WebSocketImpl = WebSocket) {
  return new Promise((resolve, reject) => {
    const requestId = `cleanup-disposable-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocketImpl(WS_URL);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Timed out waiting for disposable-room cleanup.'));
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'maintenance' }));
      ws.send(JSON.stringify({ type: 'cleanup_disposable_rooms', requestId }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'cleanup_disposable_rooms_result' && msg.requestId === requestId) finish(msg);
      else if (msg.type === 'error') finish({ ok: false, code: msg.code, message: msg.message });
    });
    ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

function runPassiveRecoveryResolution({ roomId, recoveryRequestId, reason = 'Externally reconciled' } = {}, timeoutMs = 15000, WebSocketImpl = WebSocket) {
  return new Promise((resolve, reject) => {
    const requestId = `resolve-passive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocketImpl(WS_URL);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Timed out waiting for passive recovery resolution.'));
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'maintenance' }));
      ws.send(JSON.stringify({
        type: 'resolve_passive_recovery', requestId,
        roomId, recoveryRequestId, reason
      }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'resolve_passive_recovery_result' && msg.requestId === requestId) finish(msg);
      else if (msg.type === 'error') finish({ ok: false, code: msg.code, message: msg.message });
    });
    ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

function shouldRetryResult(result = {}) {
  return new Set(['DEX_UI_OFFLINE', 'DEX_CONTROL_TIMEOUT', 'DEX_CONTROL_BAD_ACTION']).has(result.code);
}

function runTabReload(tabId) {
  const numericId = Number(tabId);
  if (!numericId) return Promise.resolve({ ok: false, message: 'reload-tab requires a numeric <tab-id>.' });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Timed out waiting for tab reload.'));
    }, 15000);
    const finish = (result) => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'provider-control' }));
      ws.send(JSON.stringify({ type: 'reload_tab', tabId: numericId }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'tab_reloaded' && Number(msg.tabId) === numericId) {
        finish({ ok: true, action: 'reload_tab', tabId: numericId, message: `Tab ${numericId} reloaded.` });
      }
      if (msg.type === 'error') finish({ ok: false, code: msg.code, message: msg.message });
    });
    ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function runWithRetry({ source, command, attempts = 4, delayMs = 1400, runImpl = run }) {
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await runImpl({ source, command });
    if (result?.ok || !shouldRetryResult(result) || attempt === attempts - 1) return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.commandName === 'help-cli') return usage(0);
  const result = parsed.commandName === 'reload-extension'
    ? await runExtensionReload()
    : parsed.commandName === 'reload-tab'
      ? await runTabReload(parsed.positionals[0] || parsed.options.tabId)
      : parsed.commandName === 'cleanup-disposable-rooms'
        ? await runDisposableRoomCleanup()
        : parsed.commandName === 'resolve-passive-recovery'
          ? await runPassiveRecoveryResolution({
              roomId: parsed.options.room,
              recoveryRequestId: parsed.options.requestId,
              reason: parsed.options.reason || 'Externally reconciled'
            })
          : await runWithRetry({ source: sourceFrom(parsed.options, parsed.commandName), command: commandFrom(parsed) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    usage(1);
  });
}

module.exports = { parseArgs, sourceFrom, commandFrom, run, runExtensionReload, runTabReload, runDisposableRoomCleanup, runPassiveRecoveryResolution, shouldRetryResult, runWithRetry, main };
