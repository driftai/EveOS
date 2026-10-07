'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_MAX_OUTPUTS = 64;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_PAGE_BYTES = 16 * 1024;

function boundedInt(value, fallback, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

function createOutputSpool({
  maxOutputs = DEFAULT_MAX_OUTPUTS,
  maxBytes = DEFAULT_MAX_BYTES,
  pageBytes = DEFAULT_PAGE_BYTES,
  idFactory = () => `machine-output-${randomUUID()}`
} = {}) {
  const records = new Map();

  function store(input = {}) {
    const stdout = String(input.stdout || '');
    const stderr = String(input.stderr || '');
    const combined = stdout + (stdout && stderr ? '\n' : '') + stderr;
    const bytes = Buffer.byteLength(combined);
    if (bytes > maxBytes) {
      const error = new Error('Terminal output exceeded the bounded local spool limit.');
      error.code = 'MACHINE_OUTPUT_LIMIT';
      throw error;
    }
    const outputId = idFactory();
    records.set(outputId, Object.freeze({
      outputId,
      audience: String(input.audience || ''),
      requestId: String(input.requestId || ''),
      stdout,
      stderr,
      combined,
      bytes,
      state: String(input.state || 'completed'),
      exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
      startedAt: String(input.startedAt || ''),
      finishedAt: String(input.finishedAt || '')
    }));
    while (records.size > maxOutputs) records.delete(records.keys().next().value);
    return records.get(outputId);
  }

  function page(outputId, { audience, stream = 'combined', offset = 0, limit = pageBytes } = {}) {
    const record = records.get(String(outputId || ''));
    if (!record || !audience || record.audience !== audience) {
      const error = new Error('Terminal output is unavailable for this exact audience.');
      error.code = 'MACHINE_OUTPUT_NOT_FOUND';
      throw error;
    }
    const source = ['stdout', 'stderr', 'combined'].includes(stream) ? record[stream] : record.combined;
    const start = boundedInt(offset, 0, source.length);
    const size = Math.max(1, boundedInt(limit, pageBytes, pageBytes));
    const text = source.slice(start, start + size);
    const nextOffset = start + text.length;
    return {
      outputId: record.outputId,
      requestId: record.requestId,
      stream,
      offset: start,
      text,
      nextOffset: nextOffset < source.length ? nextOffset : null,
      totalChars: source.length,
      totalBytes: record.bytes,
      state: record.state,
      exitCode: record.exitCode
    };
  }

  return {
    store,
    page,
    has: (outputId) => records.has(String(outputId || '')),
    size: () => records.size
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_PAGE_BYTES,
  createOutputSpool
};
