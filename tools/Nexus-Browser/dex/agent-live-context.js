'use strict';

function clean(value, fallback = 'unknown') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 160);
}
const READINESS_ONLY = /^(?:i(?:'m| am)\s+)?(?:ready(?:\s+(?:to\s+(?:begin|continue|proceed)|for\s+(?:the\s+)?next\s+step))?|standing by|awaiting (?:instructions|your input|the next step))[.! ]*$/i;
function readinessOnlyReply(value) { return READINESS_ONLY.test(clean(value, '')); }

function buildAgentLiveContext({ room, member } = {}) {
  const binding = member?.binding || {};
  const transport = clean(binding.transport || binding.sessionOrigin || binding.targetClassId);
  const searchMonitor = transport.includes('search-monitor');
  return [
    'DEX LIVE CONTROL CONTRACT (authoritative for this turn):',
    `Current room: ${clean(room?.name, 'Dex Room')} (${clean(room?.id)}).`,
    `Current recipient: ${clean(member?.name, 'Agent')} (${clean(member?.id)}).`,
    `Delivery transport: ${transport}.${searchMonitor ? ' Search Monitor carries this local-agent chat; it may be required even though the model runs locally.' : ''}`,
    'Choose exactly one ending based on actual state:',
    '- [[DEX:DONE]] only after the requested work and required verification are complete. It records the reply and stops relay.',
    '- [[DEX:NOTE]] for an informational update that needs no immediate agent reply. It stops relay without claiming completion.',
    '- [[DEX:USER]] only when human input or authorization is genuinely required before progress can continue.',
    '- [[DEX:CMD {"action":"..."}]] requests one supported control operation and pauses relay; it is not proof the operation succeeded.',
    'Core command schemas (the JSON marker must be the final unquoted line):',
    '- discover: [[DEX:CMD {"action":"onboard"}]]',
    '- select room: [[DEX:CMD {"action":"use_room","room":"<exact room ID or exact name>"}]] — the field is room, never roomId.',
    '- provision: [[DEX:CMD {"action":"workspace_ensure"}]]',
    '- inspect terminal: [[DEX:CMD {"action":"terminal_status","space":"<space>","requestId":"<request>"}]] then terminal_output with outputId.',
    '- prepare Codex-backed Governor work only when that executor is deliberately selected: [[DEX:CMD {"action":"governor_prepare","space":"<space>","terminal":"<terminal>","mission":"<mission>","tier":"<tier>","expectedHead":"<sha>","allowedFiles":["<path>"]}]]',
    '- inspect supervised work: [[DEX:CMD {"action":"job_status","space":"<space>","jobId":"<job>"}]]',
    'Use the authoritative current room above; do not guess or rediscover it unless Nexus reports ambiguity.',
    'Before naming a root cause, read the available job/terminal status and output receipt. Label unverified explanations as hypotheses.',
    'Keep quota reserve, unavailable workspace/transport, stale runtime, denied authorization, and confirmed test failure distinct.',
    'Worker selection is explicit: TLO local chat, testing and approved recovery do not consume Codex quota. governor_prepare currently launches the Codex-backed Governor, even when requested by TLO; apply Codex quota only to that executor. A ready TLO is not evidence of authorized Git publication.',
    'In a single-agent room, a readiness-only reply stops after this turn instead of being relayed back to you. Meaningful work may continue; use CMD for the next operation, USER for a real blocker, NOTE for a nonblocking update, or DONE only for verified completion.'
  ].join('\n');
}

function buildRelayCapabilityPrompt({ room, member, capabilityPrompt = '' } = {}) {
  const liveContext = buildAgentLiveContext({ room, member });
  // TLO's streaming endpoint injects the same capability packs into its system
  // prompt, so repeating them here can overflow the bounded relay envelope.
  return member?.binding?.providerId === 'tlo-chat'
    ? liveContext
    : [liveContext, capabilityPrompt].filter(Boolean).join('\n\n');
}

module.exports = { buildAgentLiveContext, buildRelayCapabilityPrompt, readinessOnlyReply };
