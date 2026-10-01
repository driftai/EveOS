'use strict';

const appTargets = require('../app-targets/manager');
const chatgpt = require('../app-targets/chatgpt-windows');
const conversation = require('../app-targets/chatgpt-windows-conversation');
const titleResolver = require('../app-targets/chatgpt-windows-title');
const winapp = require('../app-targets/winapp-runner');

async function main() {
  const requireConversation = process.argv.includes('--require-conversation');
  const helper = await winapp.availability();
  const targets = await appTargets.listAppTargets({ force: true });
  const report = {
    ok: helper.available && targets.length > 0,
    helper,
    targetCount: targets.length,
    targets: targets.map((target) => ({
      id: target.id,
      providerId: target.providerId,
      providerName: target.providerName,
      title: target.title,
      pid: target.pid || null,
      windowHandle: target.windowHandle || null,
      conversationTitle: target.concreteTargetIdentity?.conversationTitle || null,
      conversationAnchor: target.concreteTargetIdentity?.conversationAnchor || null,
      transport: target.transport
    })),
    diagnostics: appTargets.discoveryDiagnostics()
  };

  if (targets[0]) {
    try {
      const snapshot = await chatgpt.probeControls({
        hwnd: targets[0].windowHandle,
        pid: targets[0].pid,
        title: targets[0].title
      });
      const groupedReply = conversation.latestAssistantReply(snapshot);
      const discoveredAnchors = conversation.conversationAnchorDigests(snapshot);
      const targetAnchors = Array.isArray(targets[0].concreteTargetIdentity?.conversationAnchors)
        ? targets[0].concreteTargetIdentity.conversationAnchors
        : targets[0].concreteTargetIdentity?.conversationAnchor
          ? [targets[0].concreteTargetIdentity.conversationAnchor] : [];
      const conversationAnchors = discoveredAnchors.length ? discoveredAnchors : targetAnchors;
      const activeConversationAnchor = conversationAnchors.at(-1) || null;
      let activeConversation = conversation.activeConversationTitle(snapshot);
      if (!activeConversation && targets[0].concreteTargetIdentity?.conversationTitle) {
        activeConversation = {
          text: targets[0].concreteTargetIdentity.conversationTitle,
          selector: null,
          source: 'target-discovery:title'
        };
      }
      if (!activeConversation && !activeConversationAnchor) {
        activeConversation = await titleResolver.resolve({ runner: winapp, snapshot });
      }
      report.chatgptUi = {
        composerFound: !!snapshot.composerSelector,
        composerSelector: snapshot.composerSelector || null,
        sendFound: !!snapshot.sendSelector,
        sendSelector: snapshot.sendSelector || null,
        recoveredComposer: !!snapshot.recoveredComposer,
        recoveredSend: !!snapshot.recoveredSend,
        generating: !!snapshot.generating,
        accessibleTextNodes: snapshot.texts.length,
        composerCandidates: (snapshot.composerCandidates || []).map(({ selector, type, automationId, rect, score }) => ({
          selector, type, automationId, rect, score
        })),
        sendCandidates: (snapshot.sendCandidates || []).map(({ selector, type, automationId, rect, score }) => ({
          selector, type, automationId, rect, score
        })),
        responseCandidates: (snapshot.responseCandidates || []).slice(0, 8).map(({ selector, type, rect, score, text }) => ({
          selector, type, rect, score, textLength: String(text || '').length
        })),
        latestResponseSelector: snapshot.responseCandidates?.find?.((entry) => entry.text === snapshot.latestResponseText)?.selector || null,
        latestResponseLength: String(snapshot.latestResponseText || '').length,
        groupedReplyParts: groupedReply?.partCount || 0,
        groupedReplyLength: String(groupedReply?.text || '').length,
        activeConversationTitle: activeConversation?.text || null,
        activeConversationAnchor,
        activeConversationAnchorCount: conversationAnchors.length,
        activeConversationSelector: activeConversation?.selector || null,
        activeConversationSource: activeConversation?.source
          || (discoveredAnchors.length ? 'content-anchor' : activeConversationAnchor ? 'target-discovery-anchor' : null),
        hwnd: snapshot.hwnd,
        pid: snapshot.pid
      };
    } catch (error) {
      report.chatgptUi = {
        composerFound: false,
        error: error.message,
        code: error.code || 'APP_INSPECT_FAILED'
      };
      report.ok = false;
    }
  }

  report.diagnostics = appTargets.discoveryDiagnostics();
  if (requireConversation
      && !report.chatgptUi?.activeConversationTitle
      && !report.chatgptUi?.activeConversationAnchor) {
    report.ok = false;
    report.requirementError = {
      code: 'APP_CONVERSATION_IDENTITY_MISSING',
      message: 'Open a concrete ChatGPT conversation with at least one completed user/assistant exchange before live App-Origin qualification.'
    };
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!helper.available) {
    process.stdout.write('\nInstall helper:\n  winget install Microsoft.winappcli --source winget\n');
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || 'APP_ORIGIN_DOCTOR_FAILED',
    error: error.message,
    detail: error.detail || null
  }, null, 2));
  process.exitCode = 1;
});
