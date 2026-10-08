#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const dexctl = require('./dexctl');
const { urls } = require('../runtime-config');

const WS_URL = process.env.NEXUS_BROWSER_WS || process.env.BROWSER_AI_BRIDGE_WS || urls().websocket;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function marker(command) { return `[[DEX:CMD ${JSON.stringify(command)}]]`; }
function shortId(prefix) { return `${prefix}-${randomUUID().slice(0, 8)}`; }

async function discoverTargets(timeoutMs = 12000) {
  const ws = new WebSocket(WS_URL);
  let online = null, local = null;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out discovering Nexus targets.')), timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error); else resolve({ online: online || [], local: local || [] });
    }
    function maybe() { if (Array.isArray(online) && Array.isArray(local) && local.length) finish(); }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'browser' })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'tabs_update') online = Array.isArray(msg.tabs) ? msg.tabs : [];
      if (msg.type === 'local_targets_update' && Array.isArray(msg.targets)) local = msg.targets;
      maybe();
    });
    ws.on('error', finish);
  });
}

function sourceFromTarget(target) {
  return {
    targetClassId: 'local-origin',
    targetId: String(target.id),
    providerId: String(target.providerId),
    providerName: target.providerName || target.title || target.providerId,
    title: target.title || target.providerName || target.providerId
  };
}

function chooseTarget(values, providerId, explicitId = null) {
  if (explicitId != null) return values.find((entry) => String(entry.id) === String(explicitId) && (!providerId || entry.providerId === providerId)) || null;
  return values.find((entry) => !providerId || entry.providerId === providerId) || null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  return {
    sourceTargetId: value('--source-target-id') || process.env.DEX_QUALIFY_SOURCE_TARGET_ID || null,
    harkTabId: value('--hark-tab-id') || process.env.DEX_QUALIFY_HARK_TAB_ID || null,
    skipQuorum: argv.includes('--skip-quorum'),
    timeoutMs: Math.max(30000, Math.min(5 * 60 * 1000, Number(value('--timeout-ms') || 180000)))
  };
}

async function main() {
  const options = parseArgs();
  const discovered = await discoverTargets();
  const sourceTarget = chooseTarget(discovered.local, null, options.sourceTargetId);
  if (!sourceTarget) throw Object.assign(new Error('No Local-Origin target is available for disposable-room orchestration.'), { code: 'QUALIFY_LOCAL_SOURCE_REQUIRED' });
  const harkTarget = options.skipQuorum ? null : chooseTarget(discovered.online, 'hark', options.harkTabId);
  const source = sourceFromTarget(sourceTarget);
  const roomName = `MS Provider Proof ${randomUUID().slice(0, 8)}`;
  const originText = shortId('P0_ORIGIN_EXECUTED');
  const childName = shortId('Eve-Managed-Child');
  const parentName = shortId('Eve-Main-Agent-Qualification');
  const veraName = shortId('Vera-Hark-Agent-Qualification');
  const workflowId = shortId('ms-quorum');
  let roomId = null;
  let parentMemberId = null;
  let harkMemberId = null;
  let ambiguous = false;
  const evidence = { roomName, sourceTarget: { id: sourceTarget.id, providerId: sourceTarget.providerId }, harkTarget: harkTarget ? { id: harkTarget.id, providerId: harkTarget.providerId } : null };

  async function control(command) {
    const requestId = `qualify-control-${randomUUID()}`;
    try {
      const result = await dexctl.run({ source: { ...source }, command, requestId });
      if (!result?.ok) throw Object.assign(new Error(result?.message || 'Dex control failed.'), { code: result?.code || 'DEX_CONTROL_FAILED', result });
      return result;
    } catch (error) {
      if (error?.code === 'DEX_CONTROL_OUTCOME_UNKNOWN') ambiguous = true;
      throw error;
    }
  }

  async function status() { return (await control({ action: 'status', room: roomId })).data; }
  async function waitFor(predicate, label) {
    const deadline = Date.now() + options.timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await status();
      if (predicate(latest)) return latest;
      await sleep(1200);
    }
    throw Object.assign(new Error(`Timed out waiting for ${label}.`), { code: 'QUALIFY_PROVIDER_TIMEOUT', latest });
  }
  async function sendOne(text) {
    await control({ action: 'send', room: roomId, text, contextMessages: 6, relay: true });
    return waitFor((state) => state.relayActive === false && !state.waitingFor && !state.recoveryPending, 'provider relay to settle');
  }
  async function setRelay(member, enabled) {
    await control({ action: 'set_agent_relay', room: roomId, member, enabled });
  }
  async function quorumStatus() {
    const result = await control({ action: 'quorum_status', workflowId });
    return result.data;
  }

  try {
    const created = await control({ action: 'create_room', name: roomName, disposable: true, purpose: 'machine-spaces-provider-proof', selfName: 'Terminal Qualification Source' });
    roomId = created.data?.id;
    if (!roomId) throw new Error('Disposable qualification room did not return an ID.');
    evidence.roomId = roomId;
    await control({ action: 'configure_room', room: roomId, maxTurns: 1, contextDefaultMessages: 6, autoRelay: true });
    await control({ action: 'set_self_relay', room: roomId, enabled: false });

    const parent = await control({ action: 'spawn_agent', room: roomId, providerId: 'chatgpt', name: parentName });
    parentMemberId = parent.data?.addedMemberId;
    if (!parentMemberId) throw new Error('Qualification parent ChatGPT worker did not bind to the room.');
    evidence.parent = { memberId: parentMemberId, name: parentName };

    const originCommand = { action: 'send', room: roomId, text: originText, relay: false };
    await sendOne(`Automated Nexus exact-origin proof. Reply briefly, then make your FINAL line exactly this one command and emit no other Dex command:\n${marker(originCommand)}`);
    const originState = await waitFor((state) => (state.latest || []).filter((entry) => entry.text === originText).length === 1, 'exactly one origin proof control effect');
    const exactEffects = (originState.latest || []).filter((entry) => entry.text === originText).length;
    if (exactEffects !== 1) throw new Error(`Expected exactly one committed origin effect; saw ${exactEffects}.`);
    evidence.exactOrigin = { pass: true, marker: originText, exactEffects };

    const spawnCommand = { action: 'spawn_agent', room: roomId, providerId: 'chatgpt', name: childName };
    await sendOne(`Automated managed-worker proof. Reply briefly, then make your FINAL line exactly this command and emit no other Dex command:\n${marker(spawnCommand)}`);
    const spawnState = await waitFor((state) => (state.memberDetails || []).filter((entry) => entry.name === childName).length === 1, 'exactly one managed child worker');
    const children = (spawnState.memberDetails || []).filter((entry) => entry.name === childName);
    if (children.length !== 1) throw new Error(`Expected exactly one managed child; saw ${children.length}.`);
    evidence.managedSpawn = { pass: true, childMemberId: children[0].memberId, childName, exactCount: children.length };
    await control({ action: 'despawn_agent', room: roomId, member: children[0].memberId });

    if (!options.skipQuorum && harkTarget) {
      const addedHark = await control({ action: 'add_agent', room: roomId, targetClassId: 'online-origin', targetId: harkTarget.id, providerId: 'hark', name: veraName });
      const added = (addedHark.data?.memberDetails || []).find((entry) => entry.name === veraName);
      harkMemberId = added?.memberId || null;
      if (!harkMemberId) throw new Error('Hark qualification target did not bind as Vera.');
      await setRelay(harkMemberId, false);
      await setRelay(parentMemberId, true);

      const openCommand = { action: 'quorum_open', workflowId, topic: 'Machine Spaces live provider provenance', expectedAgents: ['Eve', 'Vera'], requiredAgents: ['Eve', 'Vera'], minVotes: 2 };
      await sendOne(`Automated Machine Spaces quorum proof. You are Eve. Reply briefly and end with exactly this command, no other Dex command:\n${marker(openCommand)}`);
      let workflow = await quorumStatus();
      if (workflow.workflowId !== workflowId) throw new Error('Eve did not open the expected quorum workflow.');

      const eveVote = { action: 'quorum_vote', workflowId, decision: 'approve' };
      await sendOne(`Continue the automated quorum proof as Eve. Reply briefly and end with exactly this command, no other Dex command:\n${marker(eveVote)}`);
      workflow = await quorumStatus();
      if (!(workflow.votes || []).some((vote) => vote.agent === 'Eve' && vote.provider === 'chatgpt')) throw new Error('Real Eve/ChatGPT vote was not recorded.');

      await setRelay(parentMemberId, false);
      await setRelay(harkMemberId, true);
      const veraVote = { action: 'quorum_vote', workflowId, decision: 'approve' };
      await sendOne(`Automated Machine Spaces quorum proof. You are Vera. Reply briefly and end with exactly this command, no other Dex command:\n${marker(veraVote)}`);
      workflow = await quorumStatus();
      const eveRecorded = (workflow.votes || []).some((vote) => vote.agent === 'Eve' && vote.provider === 'chatgpt');
      const veraRecorded = (workflow.votes || []).some((vote) => vote.agent === 'Vera' && vote.provider === 'hark');
      evidence.quorum = {
        status: eveRecorded && veraRecorded && workflow.result?.quorumMet === true ? 'PASS' : 'FAIL',
        workflowId,
        votes: workflow.votes,
        result: workflow.result
      };
      if (evidence.quorum.status !== 'PASS') throw new Error('Real Eve/Vera quorum did not reach approval.');
    } else {
      evidence.quorum = { status: options.skipQuorum ? 'SKIP' : 'BLOCKED', reason: options.skipQuorum ? 'Explicitly skipped.' : 'No live Hark target is connected; Eve/Hark quorum requires a real Hark provider tab.' };
    }

    evidence.status = evidence.quorum.status === 'BLOCKED' ? 'BLOCKED' : 'PASS';
  } catch (error) {
    evidence.status = ambiguous ? 'OUTCOME_UNKNOWN' : 'FAIL';
    evidence.error = { code: error.code || error.name, message: error.message };
    if (error.latest) evidence.latest = error.latest;
  } finally {
    if (roomId && !ambiguous) {
      const cleanup = [];
      try { const current = await status();
        const child = (current.memberDetails || []).find((entry) => entry.name === childName);
        if (child) cleanup.push(await control({ action: 'despawn_agent', room: roomId, member: child.memberId }));
      } catch (error) { cleanup.push({ ok: false, step: 'child-cleanup', code: error.code, message: error.message }); }
      try { if (harkMemberId) cleanup.push(await control({ action: 'remove_agent', room: roomId, member: harkMemberId })); }
      catch (error) { cleanup.push({ ok: false, step: 'hark-cleanup', code: error.code, message: error.message }); }
      try { if (parentMemberId) cleanup.push(await control({ action: 'despawn_agent', room: roomId, member: parentMemberId })); }
      catch (error) { cleanup.push({ ok: false, step: 'parent-cleanup', code: error.code, message: error.message }); }
      try { cleanup.push(await control({ action: 'delete_room', room: roomId })); }
      catch (error) { cleanup.push({ ok: false, step: 'room-cleanup', code: error.code, message: error.message }); }
      evidence.cleanup = cleanup.map((entry) => ({ ok: entry.ok !== false, action: entry.action || entry.step || null, code: entry.code || null, message: entry.message || null }));
    } else if (ambiguous) {
      evidence.cleanup = [{ ok: false, action: 'preserved', code: 'OUTCOME_UNKNOWN', message: 'Qualification room intentionally preserved because a control outcome became uncertain; do not retry blindly.' }];
    }
  }

  process.stdout.write('PROVIDER_PROVENANCE_QUALIFICATION_BEGIN\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write('PROVIDER_PROVENANCE_QUALIFICATION_END\n');
  process.exitCode = evidence.status === 'PASS' ? 0 : evidence.status === 'BLOCKED' ? 2 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write('PROVIDER_PROVENANCE_QUALIFICATION_BEGIN\n');
    process.stdout.write(JSON.stringify({ status: 'FAIL', code: error.code || error.name, message: error.message }, null, 2) + '\n');
    process.stdout.write('PROVIDER_PROVENANCE_QUALIFICATION_END\n');
    process.exitCode = 1;
  });
}

module.exports = { marker, discoverTargets, sourceFromTarget, chooseTarget, parseArgs, main };