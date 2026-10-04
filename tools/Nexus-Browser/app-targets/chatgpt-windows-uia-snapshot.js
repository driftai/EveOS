'use strict';

function snapshotFromInspect({ windowInfo, json }, api) {
  const inspectedWindow = api.windowsFromEnvelope(json)[0] || windowInfo || {};
  const elements = api.flattenElements(json);
  const frame = api.authoritativeWindowFrame(windowInfo, inspectedWindow, elements);
  const composerContext = { windowInfo: frame };
  const composerRanked = api.rankCandidates(elements, api.composerScore, composerContext);
  const composer = composerRanked[0]?.score >= 18 ? composerRanked[0].element : null;
  const sendContext = { windowInfo: frame, composer };
  const sendRanked = api.rankCandidates(elements, api.sendScore, sendContext);
  const sendButton = sendRanked[0]?.score >= 20 ? sendRanked[0].element : null;
  const texts = api.contentTexts(elements);
  const responseCandidates = api.contentCandidates(elements, frame);
  const latestResponse = api.latestResponseCandidate({ elements, windowInfo: frame, responseCandidates });
  return {
    hwnd: api.hwndOf(frame),
    pid: api.pidOf(frame),
    title: String(frame?.title || frame?.name || 'ChatGPT'),
    windowInfo: frame,
    elements,
    composer,
    composerSelector: api.selectorOf(composer),
    composerValue: composer ? api.normalizeCandidate(api.textOf(composer)) : '',
    composerCandidates: composerRanked.slice(0, 5).map((entry) => api.candidateSummary(entry.element, entry.score)),
    sendButton,
    sendSelector: api.selectorOf(sendButton),
    sendCandidates: sendRanked.slice(0, 5).map((entry) => api.candidateSummary(entry.element, entry.score)),
    generating: api.isGenerating(elements),
    texts,
    responseCandidates,
    latestResponseText: latestResponse?.text || '',
    latestText: latestResponse?.text || texts.at(-1) || ''
  };
}

module.exports = { snapshotFromInspect };
