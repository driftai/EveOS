#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { urls } = require('../runtime-config');
const { calculateProof } = require('../machine-spaces/trusted-terminal-attachment');

const WS_URL = process.env.NEXUS_BROWSER_WS || process.env.BROWSER_AI_BRIDGE_WS || urls().websocket;

function waitFor(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for Nexus adapter qualification response.')); }, timeoutMs);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'error') { cleanup(); reject(Object.assign(new Error(msg.message || msg.code), { code: msg.code, event: msg })); return; }
      if (!predicate(msg)) return;
      cleanup(); resolve(msg);
    };
    const onClose = () => { cleanup(); reject(new Error('Nexus websocket closed during external adapter qualification.')); };
    function cleanup() { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); }
    ws.on('message', onMessage); ws.on('close', onClose);
  });
}

async function sendAndWait(ws, payload, predicate, timeoutMs) {
  const pending = waitFor(ws, predicate, timeoutMs);
  ws.send(JSON.stringify(payload));
  return pending;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
}

function spawnProbeProcess() {
  if (process.platform === 'win32') {
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 300'], {
      windowsHide: true, detached: false, stdio: 'ignore'
    });
  }
  return spawn('sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
}

async function main() {
  const adapterId = `nexus-process-qualify-${randomUUID()}`;
  const ownerId = `terminal-owner-${randomUUID()}`;
  const requestPrefix = `external-adapter-${randomUUID()}`;
  const child = spawnProbeProcess();
  const ws = new WebSocket(WS_URL);
  let attachmentId = null;
  let humanEnabled = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Nexus websocket.')), 10000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const hello = waitFor(ws, (msg) => msg.type === 'server_session');
    ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'browser' }));
    await hello;

    await sendAndWait(ws,
      { type: 'machine_set_human_input', enabled: true },
      (msg) => msg.type === 'machine_human_input_state' && msg.enabled === true);
    humanEnabled = true;

    const registered = await sendAndWait(ws,
      { type: 'machine_register_trusted_adapter', adapterId },
      (msg) => msg.type === 'machine_trusted_adapter_registered' && msg.adapterId === adapterId);

    const probed = await sendAndWait(ws,
      { type: 'machine_probe_external_terminal', requestId: `${requestPrefix}-probe`, adapterId,
        pid: child.pid, cwd: process.cwd(), shellType: process.platform === 'win32' ? 'powershell' : 'sh' },
      (msg) => msg.type === 'machine_external_terminal_probe' && msg.requestId === `${requestPrefix}-probe`);

    const challengeEvent = await sendAndWait(ws,
      { type: 'machine_begin_trusted_attach', adapterId, targetId: probed.target.targetId,
        processEpoch: probed.target.processEpoch, ownerId, cwd: probed.target.cwd, shellType: probed.target.shellType },
      (msg) => msg.type === 'machine_trusted_attach_challenge' && msg.challenge?.adapterId === adapterId);
    const challenge = challengeEvent.challenge;

    const trusted = await sendAndWait(ws,
      { type: 'machine_attest_trusted_attach', challengeId: challenge.challengeId, ownerId,
        proof: calculateProof(challenge, registered.adapterSecret) },
      (msg) => msg.type === 'machine_trusted_attach_changed' && msg.action === 'trusted');
    attachmentId = trusted.attachment.attachmentId;

    const observed = await sendAndWait(ws,
      { type: 'machine_trusted_attach_observe', requestId: `${requestPrefix}-observe`, attachmentId },
      (msg) => msg.type === 'machine_trusted_attach_observation' && msg.requestId === `${requestPrefix}-observe`);

    const interrupted = await sendAndWait(ws,
      { type: 'machine_trusted_attach_interrupt', requestId: `${requestPrefix}-interrupt`, attachmentId },
      (msg) => msg.type === 'machine_trusted_attach_interrupt_result' && msg.requestId === `${requestPrefix}-interrupt`);

    await new Promise((resolve) => setTimeout(resolve, 700));
    let childAlive = true;
    try { process.kill(child.pid, 0); } catch { childAlive = false; }

    await sendAndWait(ws,
      { type: 'machine_revoke_trusted_attach', attachmentId },
      (msg) => msg.type === 'machine_trusted_attach_changed' && msg.action === 'revoked');
    attachmentId = null;
    await sendAndWait(ws,
      { type: 'machine_revoke_trusted_adapter', adapterId },
      (msg) => msg.type === 'machine_trusted_adapter_revoked' && msg.adapterId === adapterId);

    const report = {
      status: observed.observation?.alive === true && interrupted.result?.accepted === true && childAlive === false ? 'PASS' : 'FAIL',
      platform: process.platform,
      pid: child.pid,
      targetId: probed.target.targetId,
      processEpoch: probed.target.processEpoch,
      observedAlive: observed.observation?.alive === true,
      interrupt: interrupted.result,
      childAliveAfterInterrupt: childAlive,
      executeCapabilityPresent: trusted.attachment.capabilities?.includes('execute') === true
    };
    process.stdout.write('EXTERNAL_TERMINAL_ADAPTER_QUALIFICATION_BEGIN\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stdout.write('EXTERNAL_TERMINAL_ADAPTER_QUALIFICATION_END\n');
    process.exitCode = report.status === 'PASS' && report.executeCapabilityPresent === false ? 0 : 1;
  } finally {
    if (humanEnabled && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'machine_set_human_input', enabled: false })); } catch {}
    }
    try { ws.close(); } catch {}
    killTree(child.pid);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write('EXTERNAL_TERMINAL_ADAPTER_QUALIFICATION_BEGIN\n');
    process.stdout.write(JSON.stringify({ status: 'FAIL', code: error.code || error.name, reason: error.message }, null, 2) + '\n');
    process.stdout.write('EXTERNAL_TERMINAL_ADAPTER_QUALIFICATION_END\n');
    process.exitCode = 1;
  });
}

module.exports = { main, waitFor, sendAndWait, spawnProbeProcess, killTree };