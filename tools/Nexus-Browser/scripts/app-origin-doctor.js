'use strict';

const appTargets = require('../app-targets/manager');
const chatgpt = require('../app-targets/chatgpt-windows');
const winapp = require('../app-targets/winapp-runner');

async function main() {
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
      transport: target.transport
    })),
    diagnostics: appTargets.discoveryDiagnostics()
  };

  if (targets[0]) {
    try {
      const snapshot = await chatgpt.inspect({
        hwnd: targets[0].windowHandle,
        pid: targets[0].pid,
        title: targets[0].title
      });
      report.chatgptUi = {
        composerFound: !!snapshot.composerSelector,
        composerSelector: snapshot.composerSelector || null,
        sendFound: !!snapshot.sendSelector,
        sendSelector: snapshot.sendSelector || null,
        generating: !!snapshot.generating,
        accessibleTextNodes: snapshot.texts.length,
        composerCandidates: (snapshot.composerCandidates || []).map(({ selector, type, automationId, rect, score }) => ({
          selector, type, automationId, rect, score
        })),
        sendCandidates: (snapshot.sendCandidates || []).map(({ selector, type, automationId, rect, score }) => ({
          selector, type, automationId, rect, score
        })),
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
