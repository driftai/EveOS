'use strict';

const conversation = require('./chatgpt-windows-conversation');

async function recoverAuthoritativeReply({ inspect, target, baseline, prompt } = {}) {
  if (typeof inspect !== 'function' || !target || !prompt) return null;
  try {
    const snapshot = await inspect({
      hwnd: target.windowHandle,
      pid: target.pid,
      title: target.title
    }, { includeOffscreen: true, depth: 32 });
    if (snapshot.generating) return null;
    const observed = conversation.responseForPrompt(snapshot, {
      baseline,
      prompt,
      includeOffscreen: true
    });
    const text = String(observed.nativeTurn?.text || '').trim();
    if (!observed.correlated || !text) return null;
    return { text, snapshot, nativeTurn: observed.nativeTurn };
  } catch {
    return null;
  }
}

module.exports = { recoverAuthoritativeReply };
