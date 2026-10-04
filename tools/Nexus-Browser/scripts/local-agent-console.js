const readline = require('node:readline');
const { WebSocket } = require('ws');
const { urls } = require('../runtime-config');

const WS_URL = process.env.NEXUS_BROWSER_WS || process.env.BROWSER_AI_BRIDGE_WS || urls().websocket;
const providerArgIndex = process.argv.indexOf('--provider');
const requestedProviderId = providerArgIndex >= 0 ? String(process.argv[providerArgIndex + 1] || '').trim() : '';
const ws = new WebSocket(WS_URL);
let target = null;
let rl = null;
const partials = new Map();
const activityCounts = new Map();

function requestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function send(payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function redraw() {
  if (rl) rl.prompt(true);
}

function formatStatus(status = {}) {
  const bits = [];
  bits.push(status.running ? 'running' : 'idle');
  if (status.pid) bits.push(`pid=${status.pid}`);
  if (status.busy) bits.push('busy');
  if (status.queued) bits.push(`queued=${status.queued}`);
  if (status.conversationId) bits.push(`conversation=${status.conversationId}`);
  return bits.join(' · ');
}

function startReadline() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt('You> ');
  console.log('Commands: /status, /quit');
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return redraw();
    if (text === '/quit' || text === '/exit') {
      ws.close();
      rl.close();
      return;
    }
    if (text === '/status') {
      send({ type: 'request_local_status', targetId: target?.id || null });
      return redraw();
    }
    if (!target) {
      console.log('No Antigravity Local-Origin target is connected.');
      return redraw();
    }
    const id = requestId();
    send({ type: 'send_prompt', requestId: id, text, targetClassId: 'local-origin', targetId: target.id });
    redraw();
  });
  rl.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
  redraw();
}

function printPartial(msg) {
  const previous = partials.get(msg.requestId) || '';
  const next = String(msg.text || '');
  const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
  if (!previous) process.stdout.write(`\n${msg.providerName || 'Agent'}> `);
  process.stdout.write(delta);
  partials.set(msg.requestId, next);
}

function printFinal(msg) {
  const previous = partials.get(msg.requestId) || '';
  const finalText = String(msg.text || '');
  if (previous) {
    if (finalText.startsWith(previous)) process.stdout.write(finalText.slice(previous.length));
    process.stdout.write('\n');
  } else {
    console.log(`\n${msg.providerName || 'Agent'}> ${finalText}`);
  }
  partials.delete(msg.requestId);
  activityCounts.delete(msg.requestId);
  if (msg.conversationId) console.log(`[conversation ${msg.conversationId}]`);
  redraw();
}

function printActivity(msg) {
  const events = msg.activity?.events || [];
  const seen = activityCounts.get(msg.requestId) || 0;
  for (const event of events.slice(seen)) {
    console.log(`\n[${event.label || event.type || 'activity'}]${event.text ? `\n${event.text}` : ''}`);
  }
  activityCounts.set(msg.requestId, events.length);
  redraw();
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'local_targets_update': {
      const targets = Array.isArray(msg.targets) ? msg.targets : [];
      const preferred = requestedProviderId
        ? targets.find((entry) => entry.providerId === requestedProviderId)
        : targets.find((entry) => entry.providerId === 'local-antigravity-cli');
      if (!preferred) {
        console.error(requestedProviderId
          ? `No Local-Origin provider named ${requestedProviderId} is available.`
          : 'No Antigravity Local-Origin target detected. Is agy installed and on PATH?');
        return;
      }
      if (!target || target.id !== preferred.id) send({ type: 'select_local_target', targetId: preferred.id });
      break;
    }
    case 'local_target_selected':
      target = msg.target || null;
      console.log(`Connected: ${target?.title || 'Local-Origin target'}`);
      if (msg.status) console.log(`Status: ${formatStatus(msg.status)}`);
      send({ type: 'request_local_status', targetId: target?.id || null });
      startReadline();
      break;
    case 'local_target_status':
      if (!target || msg.targetId === target.id) console.log(`\nStatus: ${formatStatus(msg.status || {})}`);
      redraw();
      break;
    case 'local_prompt_echo':
      console.log(`\nBrowser> ${msg.text || ''}`);
      redraw();
      break;
    case 'prompt_accepted':
      break;
    case 'response_partial':
      printPartial(msg);
      break;
    case 'response_final':
      printFinal(msg);
      break;
    case 'activity_update':
      printActivity(msg);
      break;
    case 'error':
      console.error(`\n${msg.code ? `${msg.code}: ` : ''}${msg.message || 'Unknown bridge error.'}`);
      redraw();
      break;
    default:
      break;
  }
}

ws.on('open', () => {
  console.log(`Nexus Browser console -> ${WS_URL}`);
  send({ type: 'hello', role: 'ui', clientKind: 'console' });
});

ws.on('message', (data) => {
  try { handleMessage(JSON.parse(String(data))); }
  catch (error) { console.error(`Invalid bridge message: ${error.message}`); }
});

ws.on('close', () => {
  if (rl) rl.close();
  console.log('\nBridge console disconnected.');
});

ws.on('error', (error) => {
  console.error(`Cannot connect to Nexus Browser at ${WS_URL}: ${error.message}`);
  console.error('Start the bridge first with START.bat or npm start.');
});
