(() => {
  // The turn ID binds an optional return receipt to exactly one Dex dispatch.
  // A bare RETURN tag cannot safely recover a stale or unrelated reply.
  const RETURN_RE = /\[\[DEX:RETURN:(dex-turn-[A-Za-z0-9-]{8,128})\]\]/g;
  const TRAILING_RE = /\s*\[\[DEX:RETURN:(dex-turn-[A-Za-z0-9-]{8,128})\]\]\s*(?:\[\[DEX:(?:DONE|USER|NOTE)\]\]\s*)*$/;

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
    return node?.getAttribute?.('data-chatgpt-selection-message-id')
      || node?.getAttribute?.('data-message-id') || null;
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
  const api = { RETURN_RE, trailingReturn, exactReturn, baseline,
    nodeIdentity, freshReply, scopedResponse };
  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeChatGptReturn = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();