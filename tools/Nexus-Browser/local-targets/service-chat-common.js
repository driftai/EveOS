'use strict';

const MAX_HISTORY = 40;

function targetEvent(target, requestId, type, detail = {}) {
  return {
    type,
    requestId,
    targetClassId: 'local-origin',
    providerId: target.providerId,
    providerName: target.providerName,
    ...detail
  };
}

function createHistoryStore() {
  const histories = new Map();
  return {
    get(targetId) { return [...(histories.get(targetId) || [])]; },
    complete(targetId, prompt, reply) {
      const next = [
        ...(histories.get(targetId) || []),
        { role: 'user', content: String(prompt) },
        { role: 'assistant', content: String(reply) }
      ].slice(-MAX_HISTORY);
      histories.set(targetId, next);
      return [...next];
    },
    clear(targetId) { histories.delete(targetId); }
  };
}

async function errorMessage(response, fallback) {
  let payload = null;
  try { payload = await response.json(); } catch {}
  const detail = payload?.detail;
  return String(payload?.error || payload?.message || detail?.message || detail || fallback || `HTTP ${response.status}`);
}

async function consumeOpenAiSse(response, onText) {
  if (!response?.body) throw new Error('The local provider returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let fullText = '';

  function accept(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trimStart();
    if (raw === '[DONE]') { completed = true; return; }
    let chunk;
    try { chunk = JSON.parse(raw); } catch { return; }
    if (chunk?.error) {
      const error = new Error(chunk.error.message || 'Local provider inference failed.');
      error.code = chunk.error.state || 'LOCAL_PROVIDER_ERROR';
      throw error;
    }
    const piece = chunk?.choices?.[0]?.delta?.content;
    if (typeof piece === 'string' && piece) {
      fullText += piece;
      onText?.(fullText);
    }
  }

  while (!completed) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) accept(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) accept(buffer);
  if (!completed) throw new Error('The local provider stream ended before completion.');
  return fullText;
}

async function sendSsePrompt({ target, requestId, text, emit, url, body, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await errorMessage(response, `${target.providerName} is unavailable.`));
  const reply = await consumeOpenAiSse(response, (partial) => {
    emit?.(targetEvent(target, requestId, 'response_partial', { text: partial }));
  });
  const finalText = reply || `${target.providerName} completed without a visible response.`;
  emit?.(targetEvent(target, requestId, 'response_final', { text: finalText }));
  return finalText;
}

module.exports = {
  MAX_HISTORY,
  targetEvent,
  createHistoryStore,
  errorMessage,
  consumeOpenAiSse,
  sendSsePrompt
};
