#!/usr/bin/env node
const fs = require('node:fs');
const { defaultLogPath } = require('./runtime-log');
const { urls } = require('../runtime-config');
const DIAGNOSTICS = process.env.NEXUS_BROWSER_DIAGNOSTICS || process.env.BROWSER_AI_BRIDGE_DIAGNOSTICS || urls().diagnostics;

async function readDiagnostics() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(DIAGNOSTICS, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function verdict(data, { serverLogAvailable = null, serverLogPath = defaultLogPath() } = {}) {
  const issues = [];
  const notes = [];
  if (serverLogAvailable !== null && data.supervised == null) issues.push('server diagnostics predate the runtime-log sensor; restart START.bat');
  else if (data.supervised && serverLogAvailable === false) issues.push('supervisor runtime log unavailable; restart START.bat so failure evidence can be captured');
  if (!data.extensionConnected) issues.push('extension offline');
  if (data.taskCompletion?.available === false) issues.push('task completion journal unavailable: ' + data.taskCompletion.error);
  if (!data.dexUiConnected) notes.push('Dex UI sleeping; localhost scheduling/recovery continues headlessly and UI opens only when control is needed');
  if (data.recoveryRooms > 0) issues.push(`${data.recoveryRooms} room(s) recovering interrupted turns`);
  if (data.durability?.turnLedger?.reliable === false) issues.push('durable turn ledger is unreliable; automatic safe-replay is disabled');
  if ((data.stateRepair?.issues || []).length) issues.push(`${data.stateRepair.issues.length} unresolved Dex state invariant issue(s)`);
  if ((data.controlPlane?.controlReceiptsPending || 0) > 0) issues.push(`${data.controlPlane.controlReceiptsPending} provider-control receipt(s) awaiting correlated result`);
  if ((data.stateRepair?.repairs || []).length) notes.push(`${data.stateRepair.repairs.length} Dex state repair(s) were applied deterministically`);
  if (data.durability?.incidents?.last) notes.push(`last incident: ${data.durability.incidents.last.code}`);
  return {
    ok: issues.length === 0,
    serverSessionId: data.serverSessionId,
    supervised: data.supervised === true,
    runtimeLog: { available: serverLogAvailable, filePath: serverLogPath },
    extensionConnected: !!data.extensionConnected,
    dexUiConnected: !!data.dexUiConnected,
    onlineTargets: data.onlineTargets || 0,
    localTargets: data.localTargets || 0,
    dexRooms: data.dexRooms || 0,
    recoveryRooms: data.recoveryRooms || 0,
    savedAt: data.savedAt || null,
    turnLedger: data.durability?.turnLedger || null,
    incidentCount: data.durability?.incidents?.count || 0,
    lastIncident: data.durability?.incidents?.last || null,
    stateRepair: data.stateRepair || { repairs: [], issues: [] },
    orchestration: data.orchestration || null,
    postIdle: data.postIdle || null,
    taskCompletion: data.taskCompletion || null,
    controlPlane: data.controlPlane || null,
    diagnose: 'npm run diagnose -- --request-id <id> --room-id <id> --provider <provider>',
    issues, notes
  };
}

async function main() {
  try {
    const logPath = defaultLogPath();
    const result = verdict(await readDiagnostics(), { serverLogAvailable: fs.existsSync(logPath), serverLogPath: logPath });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return result;
  } catch (error) {
    const result = { ok: false, serverOffline: true, issues: [error.message] };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 3;
    return result;
  }
}

if (require.main === module) main();
module.exports = { readDiagnostics, verdict, main };
