'use strict';

const crypto = require('node:crypto');
const protocol = require('../public/dex-protocol');

const SCHEMA = 'eveos.dex-final-control-evidence.v1';
const CONTROL_MARKER = /\[\s*(?:\[\s*)?DEX\s*:\s*CMD\b/i;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function payload(value) {
  const text = String(value || '');
  const bytes = Buffer.from(text, 'utf8');
  return { schema: SCHEMA, payloadChars: text.length, payloadBytes: bytes.length,
    payloadSha256: sha256(bytes), parserSha256: sha256(protocol.parseAgentReply.toString()) };
}

function transport(value) {
  const text = String(value || '');
  return CONTROL_MARKER.test(text) ? payload(text) : null;
}

function parse(value, transportEvidence = null) {
  const text = String(value || '');
  const observed = payload(text);
  const supplied = transportEvidence?.schema === SCHEMA;
  const transportMatch = !supplied || (
    transportEvidence.payloadChars === observed.payloadChars
    && transportEvidence.payloadBytes === observed.payloadBytes
    && transportEvidence.payloadSha256 === observed.payloadSha256
    && transportEvidence.parserSha256 === observed.parserSha256
  );
  let parsed = protocol.parseAgentReply(text);
  if (!transportMatch) {
    parsed = { text: text.replace(/\r\n?/g, '\n').trim(), done: false,
      needsUser: false, note: false, malformedCommand: true };
  }
  return { parsed, observed, transportEvidence: supplied ? { ...transportEvidence } : null, transportMatch };
}

function record(recordIncident, { roomId, memberId, requestId, text, parsed,
  disposition, observed, transportEvidence, transportMatch } = {}) {
  if (typeof recordIncident !== 'function') return null;
  if (!CONTROL_MARKER.test(String(text || '')) && !parsed?.providerCommand && !parsed?.malformedCommand) return null;
  return recordIncident({
    code: transportMatch ? 'DEX_FINAL_CONTROL_DISPOSITION' : 'DEX_FINAL_CONTROL_PAYLOAD_MISMATCH',
    message: transportMatch
      ? 'Recorded privacy-preserving final-control parser evidence.'
      : 'Final-control payload or parser identity changed after transport admission; execution was blocked.',
    roomId, memberId, requestId, source: 'server-scheduler-final',
    evidence: {
      schema: SCHEMA, payloadChars: observed?.payloadChars ?? null,
      payloadBytes: observed?.payloadBytes ?? null, payloadSha256: observed?.payloadSha256 || null,
      parserSha256: observed?.parserSha256 || null,
      transportPayloadSha256: transportEvidence?.payloadSha256 || null,
      transportParserSha256: transportEvidence?.parserSha256 || null,
      transportMatch: !!transportMatch, parsedAction: parsed?.providerCommand || null,
      malformed: !!parsed?.malformedCommand, dispositionAction: disposition?.action || null,
      dispositionKind: disposition?.kind || null
    }
  });
}

module.exports = { SCHEMA, CONTROL_MARKER, payload, transport, parse, record };
