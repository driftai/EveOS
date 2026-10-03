'use strict';

const conversation = require('./chatgpt-windows-conversation');
const replyProgress = require('./chatgpt-windows-reply-progress');
const { hwndOf, pidOf, latestResponseCandidate } = require('./chatgpt-windows-uia');

async function captureLatest({ target, findWindow, inspect, remembered = '', now = Date.now }) {
  const liveWindow = await findWindow();
  if (!liveWindow || String(pidOf(liveWindow)) !== String(target.pid)
      || String(hwndOf(liveWindow)) !== String(target.windowHandle)) {
    const error = new Error('The bound ChatGPT app process/window changed; explicit rebind is required.');
    error.code = 'APP_TARGET_REBIND_REQUIRED';
    throw error;
  }
  const snapshot = await inspect(liveWindow, { includeOffscreen: true });
  const grouped = conversation.latestAssistantReply(snapshot, { includeOffscreen: true });
  const live = grouped?.text || latestResponseCandidate(snapshot)?.text || snapshot.latestResponseText || '';
  const stored = conversation.hasRoleMarkers(snapshot)
    ? (live || remembered)
    : replyProgress.mergeReplyProgress(remembered, live);
  return {
    text: stored || snapshot.latestText || '', snapshot,
    replyParts: grouped?.partCount || (live ? 1 : 0), observedAt: now(),
    isGenerating: !!snapshot.generating,
    generationState: snapshot.generating ? 'active' : 'idle',
    completenessHint: snapshot.generating ? 'incomplete' : 'settled'
  };
}

module.exports = { captureLatest };
