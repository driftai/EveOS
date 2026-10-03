'use strict';

const appTargets = require('../app-targets/manager');
const storage = require('./terminal-relay-storage');

function relayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundAnchors(identity = {}) {
  return [...new Set([
    ...(Array.isArray(identity.conversationAnchors) ? identity.conversationAnchors : []),
    identity.conversationAnchor
  ].filter(Boolean).map(String))];
}

function verifyAndAdvance(selection, liveTarget) {
  const expected = selection?.target || {};
  if (!expected.id || !expected.providerId) {
    throw relayError('TERMINAL_RELAY_BINDING_STALE',
      'Saved Terminal Relay selection is incomplete. Reconnect the exact App-Origin target in Base Mode.');
  }
  if (!liveTarget || String(liveTarget.id || '') !== String(expected.id)
      || String(liveTarget.providerId || '') !== String(expected.providerId)) {
    throw relayError('TERMINAL_RELAY_BINDING_STALE',
      'Saved Terminal Relay target no longer maps to the selected App-Origin provider.');
  }

  const bound = expected.concreteTargetIdentity || {};
  const live = liveTarget.concreteTargetIdentity || {};
  const expectedPid = bound.processId || expected.pid || null;
  const expectedHwnd = bound.windowHandle || expected.windowHandle || null;
  const livePid = live.processId || liveTarget.pid || null;
  const liveHwnd = live.windowHandle || liveTarget.windowHandle || null;

  if ((expectedPid && String(expectedPid) !== String(livePid || ''))
      || (expectedHwnd && String(expectedHwnd) !== String(liveHwnd || ''))) {
    throw relayError('TERMINAL_RELAY_WINDOW_CHANGED',
      'The selected ChatGPT App process/window changed. Reconnect the intended native conversation in Base Mode.');
  }

  const hasConversationProof = !!bound.conversationTitle || boundAnchors(bound).length > 0;
  if (!expectedPid || !expectedHwnd || !hasConversationProof) {
    throw relayError('TERMINAL_RELAY_BINDING_STALE',
      'Saved Terminal Relay selection is incomplete or synthetic. Reconnect the exact native conversation in Base Mode.');
  }

  const advanced = appTargets.advanceAppTargetBinding(expected, liveTarget);
  if (!advanced) {
    throw relayError('TERMINAL_RELAY_CONVERSATION_CHANGED',
      'The selected ChatGPT App conversation changed. Reconnect the intended native conversation in Base Mode.');
  }
  return advanced;
}

function notify(onEvent, event) {
  try { onEvent?.(event); } catch {}
}

async function relayReport(report, { onEvent = null, expectedText = null } = {}) {
  console.log('\n============================================================');
  console.log('NEXUS → CHATGPT APP RELAY');
  console.log('============================================================');

  const selection = storage.readTargetSelection();
  if (!selection?.target?.id) {
    return { status: 'FAIL', accepted: false,
      reason: 'No Base Mode App-Origin target is selected. Connect the intended ChatGPT App conversation first.' };
  }
  if (selection.target.providerId !== 'chatgpt-desktop') {
    return { status: 'FAIL', accepted: false,
      reason: 'The selected App-Origin target is not the ChatGPT Windows provider.' };
  }

  let accepted = false;
  try {
    const result = await appTargets.sendAppPrompt({
      targetId: selection.target.id,
      requestId: 'terminal-relay-' + Date.now().toString(36),
      text: report,
      beforeSend: async (liveTarget) => {
        const advanced = verifyAndAdvance(selection, liveTarget);
        if (!storage.refreshTargetSelection(advanced)) {
          throw relayError('TERMINAL_RELAY_BINDING_STALE',
            'Terminal Relay selection changed while the send lease was being acquired. Reconnect it before relaying.');
        }
        console.log('Target:', advanced.title, 'PID', advanced.pid, 'HWND', advanced.windowHandle);
        notify(onEvent, { type: 'target_verified', target: advanced });
      },
      emit(event) {
        notify(onEvent, event);
        if (event.type === 'prompt_accepted') {
          accepted = true;
          console.log('[relay] ChatGPT App accepted terminal report.');
        }
        if (event.type === 'response_partial') {
          console.log('[relay] partial reply:', String(event.text || '').length, 'chars');
        }
        if (event.type === 'response_final') {
          console.log('[relay] final reply:', String(event.text || '').length, 'chars');
        }
      }
    });
    const matched = expectedText == null ? null : String(result?.text || '').trim() === String(expectedText).trim();
    return {
      status: matched === false ? 'FAIL' : 'PASS',
      accepted,
      reason: matched === false ? 'The captured ChatGPT App reply did not match the expected text.'
        : 'Report delivered to the selected ChatGPT App conversation and reply capture completed.',
      replyLength: String(result?.text || '').length,
      matched
    };
  } catch (error) {
    if (accepted) {
      return { status: 'DELIVERED_CAPTURE_FAILED', accepted: true,
        reason: error.message, code: error.code || null, error: error.stack || String(error) };
    }
    return { status: 'FAIL', accepted: false,
      reason: error.message, code: error.code || null, error: error.stack || String(error) };
  }
}

async function relayMessageCli(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--message');
  const message = index >= 0 ? String(argv[index + 1] || '').trim() : '';
  const expectedIndex = argv.indexOf('--expect');
  const expectedText = expectedIndex >= 0 ? String(argv[expectedIndex + 1] || '') : null;
  if (!message) throw relayError('TERMINAL_RELAY_MESSAGE_REQUIRED', 'Pass a non-empty --message value.');
  const result = await relayReport(message, { expectedText });
  console.log(`TERMINAL_RELAY_MESSAGE_${result.status} ${JSON.stringify({
    accepted: result.accepted, matched: result.matched, replyLength: result.replyLength || 0, reason: result.reason
  })}`);
  if (result.status !== 'PASS') process.exitCode = 1;
  return result;
}

if (require.main === module) {
  relayMessageCli().catch((error) => {
    console.error(`TERMINAL_RELAY_MESSAGE_ERROR ${error.code || 'ERROR'} ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { relayReport, relayMessageCli, verifyAndAdvance, boundAnchors };
