'use strict';
// Base Mode uses the existing authenticated localhost UI transport for
// Local-Origin discovery and the shared Search Monitor TLO conversation.
const { randomUUID } = require('node:crypto');
const { askLine, safe } = require('./dex-tui');
const { promptFor } = require('./dex-tui-identity');
const { createPromptOutput } = require('./dex-tui-output');
const { createPeer } = require('./dex-tui-peer');
const TLO_ID = 'local:tlo-chat:default';
const cleanBaseReply = value => safe(value, 1800).replace(/\s*\[\[DEX:DONE\]\]\s*$/u, '').trimEnd();
function showTargets(targets) {
  const lines = ['\n  BASE  /  LOCAL TARGETS'];
  targets.forEach((target, index) => lines.push(`  ${index + 1}  ${safe(target.providerName || target.title)}  [${safe(target.targetTypeName || 'local', 32)}]`));
  lines.push('  /refresh targets · /home main menu · /quit exit');
  return lines.join('\n');
}
async function runBase({ input = process.stdin, output = process.stdout, displayName = 'User', id = () => `base-tui-${randomUUID()}`,
  createConnection = createPeer } = {}) {
  let peer, targets = [], selected = null, pending = null, closed = false;
  const promptView = createPromptOutput(output);
  const say = value => { if (!closed) promptView.write(value); };
  function event(message) {
    if (closed || !pending) return;
    if (message.type === 'transport_closed') {
      say(`  ! Connection lost; outcome unknown for ${pending.requestId}. Do not resend.`);
      pending.state = 'unknown'; return;
    }
    if (message.requestId !== pending.requestId) return;
    if (message.type === 'prompt_accepted') { say('  · Accepted by local transport'); return; }
    // Partial updates are intentionally suppressed in Base V1.
    if (message.type === 'response_partial') return;
    if (message.type === 'response_final') {
      say(`\n  ${safe(pending.providerName || 'Agent')}/Base> ${cleanBaseReply(message.text || '')}\n`);
      pending = null;
    } else if (message.type === 'error') {
      say(`  ! ${safe(message.code)}: ${safe(message.message, 400)} (request ${pending.requestId})`);
      pending = null;
    }
  }
  try {
    peer = createConnection({ onEvent: event });
    await peer.start;
    async function refresh() {
      const snapshot = await peer.request({ type: 'request_local_targets', force: true },
        value => value.type === 'local_targets_update' && value.refreshing !== true);
      targets = (snapshot.targets || []).filter(t => t?.id && t.targetClassId === 'local-origin').slice(0, 32);
    }
    await refresh();
    let screen = 'targets';
    for (;;) {
      if (screen === 'targets') {
        say(showTargets(targets));
        const value = await askLine(input, output, 'base> ', promptView);
        if (value === null || value.trim() === '/quit') return { navigation: 'quit' };
        if (['/home', '/back'].includes(value.trim())) return { navigation: 'home' };
        if (value.trim() === '/refresh') { await refresh(); continue; }
        const index = /^\d+$/.test(value.trim()) ? Number(value.trim()) - 1 : -1;
        const target = targets[index] || targets.find(t => t.id === value.trim());
        if (!target) { say('  ! Select a listed number or exact target ID.'); continue; }
        try {
          await peer.request({ type: 'select_local_target', targetId: target.id },
            msg => msg.type === 'local_target_selected' && msg.target?.id === target.id);
        } catch (error) { say(`  ! Target selection refused: ${safe(error.message)}`); continue; }
        selected = target;
        say(`\n  Connected: ${safe(target.title)}\n  ${safe(target.id, 128)}`);
        say(`  Input: ${promptFor(displayName, 'Base').trim()} · replies: ${safe(target.providerName || 'Agent')}/Base>`);
        say('  /targets choose another · /home leave · /quit exit');
        if (target.id !== TLO_ID && target.id !== 'local:local-moe-chat:default')
          say('  Read-only target view: interactive chat requires separate validation.');
        screen = 'chat';
      } else {
        const value = await askLine(input, output, promptFor(displayName, 'Base'), promptView);
        if (value === null || value.trim() === '/quit') return { navigation: 'quit' };
        if (['/home', '/back'].includes(value.trim())) return { navigation: 'home' };
        if (value.trim() === '/targets') {
          if (pending) say(`  ! Request ${pending.requestId} is still unresolved; do not resend after leaving.`);
          selected = null; screen = 'targets'; continue;
        }
        if (value.trim() === '/status') { say(pending ? `  ${pending.state === 'unknown' ? 'Outcome unknown for' : 'Pending exact request:'} ${pending.requestId}` : '  No in-flight request.'); continue; }
        if (value.trim().startsWith('/')) { say('  /status · /targets · /home · /quit'); continue; }
        if (!value.trim()) continue;
        if (![TLO_ID, 'local:local-moe-chat:default'].includes(selected.id)) {
          say('  ! This target is currently inspect-only in terminal Base Mode.'); continue;
        }
        if (pending) { say(`  ! Still waiting for ${pending.requestId}; no duplicate prompt sent.`); continue; }
        if (value.length > 1800) { say('  ! Message must be at most 1800 characters.'); continue; }
        const requestId = id();
        pending = { requestId, targetId: selected.id, providerName: selected.providerName };
        if (!peer.send({ type: 'send_prompt', targetClassId: 'local-origin', targetId: selected.id,
          requestId, text: value.trim(), clientSentAt: Date.now() })) {
          say(`  ! Transport unavailable. Outcome unknown for ${requestId}; do not resend automatically.`);
          pending = null;
        } else say(`  · Submitted [${requestId}] · waiting for exact final`);
      }
    }
  } catch (error) {
    say(`  ! Base connection unavailable: ${safe(error.message, 300)}`);
    return { navigation: 'home' };
  } finally {
    if (pending) say(`  ! Unresolved Base request ${pending.requestId}; leaving does not cancel or replay it.`);
    closed = true;
    peer?.close();
  }
}
module.exports = { TLO_ID, showTargets, runBase, cleanBaseReply };
