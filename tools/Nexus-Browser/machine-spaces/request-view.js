'use strict';

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;
const LIVE_STATES = new Set(['approval-required', 'queued', 'running', 'deferred']);

function text(value) { return String(value ?? '').trim(); }
function lower(value) { return text(value).toLowerCase(); }
function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}
function provenance(request = {}) {
  return Object.freeze({
    requestId: text(request.requestId) || null,
    sourceMessageId: text(request.sourceMessageId) || null,
    actorMemberId: text(request.actorMemberId || request.ownerMemberId) || null,
    actorName: text(request.actorName) || null,
    terminalId: text(request.terminalId || request.targetId) || null,
    processEpoch: text(request.processEpoch) || null,
    grantId: text(request.grantId) || null,
    capability: text(request.capability) || null,
    commandDigest: text(request.commandDigest) || null,
    operationDigest: text(request.operationDigest) || null,
    outputId: text(request.outputId || request.result?.outputId) || null
  });
}
function classify(request = {}) {
  if (request.requestKind) return text(request.requestKind);
  if (request.jobId || request.kind === 'terminal-supervised') return 'supervised';
  if (request.capability || request.operationDigest || request.operationSummary) return 'filesystem';
  return 'terminal';
}
function summary(request = {}) {
  const kind = classify(request);
  if (kind === 'filesystem') return text(request.operationSummary) || `${text(request.capability) || 'filesystem'} ${text(request.path)}`.trim();
  if (kind === 'supervised') return text(request.commandPreview) || text(request.commandSummary) || text(request.reason) || 'supervised terminal job';
  return text(request.command) || text(request.commandSummary) || 'terminal command';
}
function project(request = {}) {
  const state = lower(request.state) || 'unknown';
  return Object.freeze({
    id: text(request.requestId || request.jobId),
    kind: classify(request),
    state,
    live: LIVE_STATES.has(state),
    createdAt: text(request.createdAt) || null,
    finishedAt: text(request.finishedAt) || null,
    summary: summary(request),
    resultSummary: text(request.resultSummary || request.reason) || null,
    errorCode: text(request.errorCode) || null,
    provenance: provenance(request),
    raw: request
  });
}
function normalizedFilter(options = {}) {
  const kinds = new Set((Array.isArray(options.kinds) ? options.kinds : options.kind ? [options.kind] : []).map(lower).filter(Boolean));
  const states = new Set((Array.isArray(options.states) ? options.states : options.state ? [options.state] : []).map(lower).filter(Boolean));
  return {
    kinds,
    states,
    actor: lower(options.actor),
    query: lower(options.query),
    liveOnly: options.liveOnly === true
  };
}
function matches(item, filter) {
  if (filter.kinds.size && !filter.kinds.has(lower(item.kind))) return false;
  if (filter.states.size && !filter.states.has(lower(item.state))) return false;
  if (filter.liveOnly && !item.live) return false;
  if (filter.actor) {
    const actor = lower(`${item.provenance.actorName || ''} ${item.provenance.actorMemberId || ''}`);
    if (!actor.includes(filter.actor)) return false;
  }
  if (filter.query) {
    const haystack = lower([
      item.id, item.kind, item.state, item.summary, item.resultSummary, item.errorCode,
      ...Object.values(item.provenance || {})
    ].filter(Boolean).join(' '));
    if (!haystack.includes(filter.query)) return false;
  }
  return true;
}
function encodeCursor(item) {
  if (!item) return null;
  const raw = JSON.stringify([timestamp(item.createdAt), item.id || '']);
  return Buffer.from(raw, 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return { at: Number(at) || 0, id: text(id) };
  } catch { return null; }
}
function compareItems(a, b) {
  const time = timestamp(b.createdAt) - timestamp(a.createdAt);
  if (time) return time;
  return String(b.id || '').localeCompare(String(a.id || ''));
}
function afterCursor(item, cursor) {
  if (!cursor) return true;
  const at = timestamp(item.createdAt);
  if (at < cursor.at) return true;
  if (at > cursor.at) return false;
  return String(item.id || '').localeCompare(cursor.id) < 0;
}
function buildRequestView({ terminalRequests = [], fileRequests = [], supervisedJobs = [] } = {}, options = {}) {
  const filter = normalizedFilter(options);
  const limit = clampInt(options.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const cursor = decodeCursor(options.cursor);
  const projected = [
    ...terminalRequests.map((entry) => project({ ...entry, requestKind: entry.requestKind || 'terminal' })),
    ...fileRequests.map((entry) => project({ ...entry, requestKind: entry.requestKind || 'filesystem' })),
    ...supervisedJobs.map((entry) => project({ ...entry, requestKind: entry.requestKind || 'supervised' }))
  ].filter((item) => matches(item, filter)).sort(compareItems).filter((item) => afterCursor(item, cursor));
  const items = projected.slice(0, limit);
  const hasMore = projected.length > items.length;
  return Object.freeze({
    items,
    count: items.length,
    hasMore,
    nextCursor: hasMore ? encodeCursor(items.at(-1)) : null,
    filters: Object.freeze({
      kinds: [...filter.kinds], states: [...filter.states], actor: filter.actor || null,
      query: filter.query || null, liveOnly: filter.liveOnly
    })
  });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  LIVE_STATES,
  provenance,
  classify,
  project,
  buildRequestView,
  encodeCursor,
  decodeCursor
};
