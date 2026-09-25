(() => {
  // The turn ID binds an optional return receipt to exactly one Dex dispatch.
  // A bare RETURN tag cannot safely recover a stale or unrelated reply.
  const RETURN_RE = /\[\[DEX:RETURN:(dex-turn-[A-Za-z0-9-]{8,128})\]\]/g;
  const TRAILING_RE = /\s*\[\[DEX:RETURN:(dex-turn-[A-Za-z0-9-]{8,128})\]\]\s*(?:\[\[DEX:(?:HEADSUP:[^\]\[\r\n]{1,80}|DONE|USER|NOTE)\]\]\s*)*$/;

  function trailingReturn(value) {
    const text = String(value || '').trim();
    const match = TRAILING_RE.exec(text);
    return match ? { requestId: match[1], index: match.index } : null;
  }
  function exactReturn(value, requestId) {
    const tag = trailingReturn(value);
    return !!requestId && tag?.requestId === String(requestId);
  }
  function nodeIdentity(node) {
    const container = node?.closest?.('[data-chatgpt-selection-message-id], [data-message-id]') || node;
    return container?.getAttribute?.('data-chatgpt-selection-message-id')
      || container?.getAttribute?.('data-message-id') || null;
  }
  function baseline(nodes = []) {
    return { count: nodes.length, refs: new Set(nodes),
      ids: new Set(nodes.map(nodeIdentity).filter(Boolean)) };
  }
  function freshReply(answer, before) {
    const nodes = answer?.assistantNodes?.() || [];
    const newNodes = nodes.filter((node) => {
      const id = nodeIdentity(node);
      return !before.refs.has(node) && (!id || !before.ids.has(id));
    });
    if (newNodes.length !== 1) return '';
    const candidate = newNodes[0];
    return String(answer.assistantText?.(candidate)
      || answer.assistantTurnText?.(candidate) || '').trim();
  }
  function scopedResponse(answer, prompt, userBaselineCount, before, committed) {
    const anchored = answer?.responseTextForUserPrompt?.(prompt, userBaselineCount) || '';
    if (anchored) return { text: anchored, source: 'prompt-anchor' };
    if (!committed || !before) return { text: '', source: 'unbound' };
    // Only allow a single genuinely new assistant turn after the known
    // successful prompt submission. Reflowed old messages do not qualify.
    const text = freshReply(answer, before);
    return { text, source: text ? 'fresh-assistant-turn' : 'unbound' };
  }
  const notificationIds = new Set(), notificationTexts = new Set();
  const rememberBounded = (set, value, max) => {
    if (!value) return;
    set.add(value);
    while (set.size > max) set.delete(set.values().next().value);
  };
  function rememberNotificationReply(answer, text, before = null) {
    const nodes = answer?.assistantNodes?.() || [], latest = nodes[nodes.length - 1];
    const id = nodeIdentity(latest);
    if (latest && !before?.refs?.has(latest) && (!id || !before?.ids?.has(id)))
      rememberBounded(notificationIds, id, 64);
    rememberBounded(notificationTexts, String(text || '').trim(), 16);
  }
  function isNotificationReply(answer, text) {
    const nodes = answer?.assistantNodes?.() || [];
    const id = nodeIdentity(nodes[nodes.length - 1]);
    if (id) return notificationIds.has(id);
    return notificationTexts.has(String(text || '').trim());
  }
  const api = { RETURN_RE, trailingReturn, exactReturn, baseline,
    nodeIdentity, freshReply, scopedResponse, rememberNotificationReply, isNotificationReply };
  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeChatGptReturn = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();