(() => {
  const DONE_TOKEN = '[[DEX:DONE]]';
  const USER_TOKEN = '[[DEX:USER]]';
  const NOTE_TOKEN = '[[DEX:NOTE]]';
  const CONTROL_TOKENS = Object.freeze({ done: DONE_TOKEN, user: USER_TOKEN, note: NOTE_TOKEN });
  const CONTROL_BY_TOKEN = Object.freeze(Object.fromEntries(
    Object.entries(CONTROL_TOKENS).map(([kind, token]) => [token, kind])
  ));
  const DEFAULT_MAX_CONTEXT_CHARS = 10000;
  const DEFAULT_MAX_MESSAGE_CHARS = 1800;
  const MAX_RELAY_TURNS = 500;
  const PROVIDER_CONTROL_ACTIONS = new Set([
    'help', 'onboard', 'checkpoint', 'read_checkpoint', 'rooms', 'targets', 'create_room', 'use_room', 'status',
    'rename_room', 'configure_room', 'rename_self', 'set_self_relay', 'rename_agent', 'set_agent_relay', 'remove_agent',
    'stop_relay', 'continue_relay', 'clear_chat', 'delete_room', 'add_agent', 'spawn_agent', 'despawn_agent', 'send', 'handoff_room', 'reload_extension'
  ]);
  const NESTED_RELAY_MARKER = /\[{1,2}DEX ROOM RELAY\]/i;
  const OLD_CONTEXT_TRUNCATION = '[truncated by Dex context window]';
  const NESTED_RELAY_OMISSION = '[Quoted Dex transport envelope omitted from relay context; full message remains in room transcript.]';
  const MESSAGE_SHORTENED = '[message shortened by Dex context projection; full text remains in room transcript.]';

  function cleanName(value, fallback = 'Agent') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 48);
  }

  function cleanText(value) {
    return String(value || '').replace(/\r\n?/g, '\n').trim();
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function messageWrapper(message = {}) {
    const body = cleanText(message.text);
    if (message.senderKind === 'user') {
      return `${body}\n\n- From User (${cleanName(message.senderName, 'User')})`;
    }
    if (message.senderKind === 'agent') {
      return `${body}\n\n- From ${cleanName(message.senderName, 'Agent')}`;
    }
    return body;
  }

  function trailingProviderCommand(value) {
    const text = cleanText(value), prefix = '[[DEX:CMD ';
    if (!text.endsWith(']]')) return null;
    let index = text.indexOf(prefix);
    while (index >= 0) {
      try {
        const command = JSON.parse(text.slice(index + prefix.length, -2).trim());
        const action = cleanText(command?.action).toLowerCase();
        if (PROVIDER_CONTROL_ACTIONS.has(action)) return { command, action, index };
      } catch {}
      index = text.indexOf(prefix, index + prefix.length);
    }
    return null;
  }

  function trailingHandoff(value) {
    const parsed = trailingProviderCommand(value);
    if (!parsed || parsed.action !== 'handoff_room' || !cleanText(parsed.command.room) || !cleanText(parsed.command.text)) return null;
    return parsed;
  }

  function parseAgentReply(value) {
    let text = cleanText(value);
    const providerCommand = trailingProviderCommand(text);
    const handoff = providerCommand?.action === 'handoff_room'
      && cleanText(providerCommand.command.room) && cleanText(providerCommand.command.text)
      ? providerCommand : null;
    if (providerCommand) text = cleanText(text.slice(0, providerCommand.index));
    const controls = new Set();
    const trailingToken = /\s*(\[\[DEX:[A-Z_]+\]\])\s*$/;
    let match = text.match(trailingToken);
    while (match) {
      const kind = CONTROL_BY_TOKEN[match[1]];
      if (!kind) break;
      controls.add(kind);
      text = cleanText(text.slice(0, match.index));
      match = text.match(trailingToken);
    }
    return {
      text,
      done: controls.has('done'),
      needsUser: controls.has('user'),
      note: controls.has('note'),
      ...(providerCommand ? { providerCommand: providerCommand.action, providerControlCommand: providerCommand.command } : {}),
      ...(handoff ? { handoff: true } : {})
    };
  }

  function relayDisposition(parsed = {}, memberName = 'Agent', repeated = false, relay = {}) {
    const name = cleanName(memberName, 'Agent');
    if (parsed.handoff) return { action: 'stop', kind: 'handoff', reason: `${name} requested a cross-room handoff` };
    if (parsed.providerCommand) return { action: 'stop', kind: 'control', reason: `${name} requested Dex provider control` };
    if (parsed.needsUser) return { action: 'stop', kind: 'user', reason: `${name} requested user input` };
    if (parsed.done) return { action: 'stop', kind: 'done', reason: `${name} marked the room complete` };
    if (parsed.note) return { action: 'stop', kind: 'note', reason: `${name} posted a note` };
    if (repeated) return { action: 'stop', kind: 'loop', reason: 'Loop guard stopped a repeated reply' };
    if (!relay.active) return { action: 'stop', kind: 'stopped', reason: relay.lastStopReason || 'Relay stopped' };
    if (relay.remaining <= 0) return { action: 'stop', kind: 'budget', reason: 'Relay budget complete' };
    return { action: 'continue', kind: 'reply', reason: null };
  }

  function memberSummary(member) {
    const binding = member?.binding || {};
    const origin = binding.targetClassId === 'local-origin' ? 'Local-Origin' : 'Online-Origin';
    const provider = binding.providerName || binding.providerId || 'Provider';
    const mode = member?.relayEnabled === false ? ' · observer' : '';
    return `${cleanName(member?.name, 'Agent')} [${origin} / ${provider}${mode}]`;
  }

  function collapseNestedRelay(value) {
    const text = cleanText(value);
    const markerIndex = text.search(NESTED_RELAY_MARKER);
    if (markerIndex < 0) return text;

    const prefix = cleanText(text.slice(0, markerIndex));
    const oldTruncationIndex = text.indexOf(OLD_CONTEXT_TRUNCATION, markerIndex);
    if (oldTruncationIndex >= 0) {
      const suffix = cleanText(text.slice(oldTruncationIndex + OLD_CONTEXT_TRUNCATION.length));
      return [prefix, NESTED_RELAY_OMISSION, suffix].filter(Boolean).join('\n\n');
    }

    const envelopeLength = text.length - markerIndex;
    if (envelopeLength <= 800) {
      return [prefix, NESTED_RELAY_OMISSION].filter(Boolean).join('\n\n');
    }

    const relayLines = cleanText(text.slice(markerIndex)).split('\n').map((line) => line.trim()).filter(Boolean);
    const lastLine = relayLines.at(-1) || '';
    const previousLine = relayLines.at(-2) || '';
    let tail = lastLine.length > 400 ? lastLine.slice(-400) : lastLine;
    if (previousLine && tail.length < 240 && previousLine.length + tail.length + 1 <= 500) {
      tail = `${previousLine}\n${tail}`;
    }
    return [prefix, NESTED_RELAY_OMISSION, tail].filter(Boolean).join('\n\n');
  }

  function projectContextText(value, maxChars = DEFAULT_MAX_MESSAGE_CHARS) {
    const limit = Math.max(256, Number(maxChars) || DEFAULT_MAX_MESSAGE_CHARS);
    const text = collapseNestedRelay(value);
    if (text.length <= limit) return text;

    const marker = `\n\n${MESSAGE_SHORTENED}\n\n`;
    const contentBudget = Math.max(64, limit - marker.length);
    const headChars = Math.ceil(contentBudget * 0.65);
    const tailChars = Math.max(0, contentBudget - headChars);
    return `${text.slice(0, headChars)}${marker}${tailChars ? text.slice(-tailChars) : ''}`;
  }

  function projectedMessageBlock(message, perMessageChars = DEFAULT_MAX_MESSAGE_CHARS) {
    const text = projectContextText(message?.text, perMessageChars);
    return messageWrapper({ ...message, text });
  }

  function boundedContext(messages, limit = 8, maxChars = DEFAULT_MAX_CONTEXT_CHARS) {
    const messageLimit = clampInt(limit, 2, 20, 8);
    const budget = Math.max(512, Number(maxChars) || DEFAULT_MAX_CONTEXT_CHARS);
    const perMessageChars = Math.max(256, Math.min(DEFAULT_MAX_MESSAGE_CHARS, budget - 128));
    const separator = '\n\n---\n\n';
    const candidates = (Array.isArray(messages) ? messages : [])
      .filter((message) => message?.senderKind === 'user' || message?.senderKind === 'agent')
      .slice(-messageLimit);

    const newestFirst = [];
    let used = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const block = projectedMessageBlock(candidates[index], perMessageChars);
      const cost = block.length + (newestFirst.length ? separator.length : 0);
      if (used + cost > budget) break;
      newestFirst.push(block);
      used += cost;
    }

    return newestFirst.reverse().join(separator);
  }

  function buildRelayPrompt({ room, recipient, member, sourceMessage, requestId, providerHealth = '' }) {
    const addressed = recipient || member;
    const participants = (room?.members || []).map((entry) => `- ${memberSummary(entry)}`).join('\n') || '- none';
    const contextLimit = clampInt(room?.settings?.contextMessages, 2, 20, 8);
    const history = (room?.messages || []).filter((message) => message.id !== sourceMessage?.id);
    const context = boundedContext(history, contextLimit);
    const source = messageWrapper(sourceMessage);
    return [
      '[DEX ROOM RELAY]',
      '',
      `Room: ${cleanName(room?.name, 'Dex Room')}`,
      `Room ID: ${room?.id || 'unknown'}`,
      `Turn ID: ${requestId || 'unknown'}`,
      `Source Message ID: ${sourceMessage?.id || 'unknown'}`,
      `Recipient: ${cleanName(addressed?.name, 'Agent')}`,
      'Participants:',
      participants,
      '',
      'Provider availability:',
      cleanText(providerHealth) || '- no blocking provider signals reported',
      '',
      'Rules:',
      '- Reply only as the Recipient. Do not impersonate another participant.',
      '- Room, routing, recipient, and speaker identity metadata are authoritative.',
      '- Do not add a "From" label; Dex attaches speaker identity automatically.',
      `- End with ${DONE_TOKEN} only when the room task is complete and no other agent must receive or acknowledge your reply. DONE records this reply in the transcript and STOPS relay before the next agent gets a turn.`,
      '- For a two-agent request that asks for direct confirmation, the responder must reply WITHOUT a control marker so Dex relays the acknowledgement to the requesting agent. The requester can then end its confirmation turn with [[DEX:DONE]]. Do not exchange extra acknowledgements.',
      '- Without a trailing marker, Dex continues to the NEXT participating agent in room order, not necessarily the original requester if the room has more than two agents.',
      `- End with ${USER_TOKEN} only when human input is required before work can continue.`,
      `- End with ${NOTE_TOKEN} only for an informational room note that should be recorded without triggering another agent turn.`,
      '- Control markers are interpreted only when they trail the reply.',
      '- Recent room context is a compact projection; Current message is the authoritative unabridged source for this turn.',
      '- Do not rewrite Room/Recipient routing in prose.',
      '- If you need Dex room/worker controls, end with [[DEX:CMD {"action":"onboard"}]] to receive the current self-service command set. A trailing provider-control command pauses this relay before the control action runs.',
      '- If this exact chat is also bound to another Dex room, an intentional transfer may end with [[DEX:CMD {"action":"handoff_room","room":"<authorized room id or exact name>","text":"<message>","turns":8}]]. Dex stops this room before starting the authorized target room.',
      '',
      'Recent room context (projected):',
      context || '(no earlier room messages)',
      '',
      'Current message:',
      source
    ].join('\n');
  }

  function nextMemberIndex(room, sourceMessage) {
    const members = room?.members || [];
    if (!members.some((member) => member.relayEnabled !== false)) return -1;
    let start = 0;
    if (sourceMessage?.senderKind === 'agent' && sourceMessage.senderId) {
      const previous = members.findIndex((member) => member.id === sourceMessage.senderId);
      if (previous >= 0) start = (previous + 1) % members.length;
    }
    for (let offset = 0; offset < members.length; offset += 1) {
      const index = (start + offset) % members.length;
      if (members[index].relayEnabled !== false) return index;
    }
    return -1;
  }

  function isRepeatedReply(messages, text, threshold = 2) {
    const normalized = cleanText(text).replace(/\s+/g, ' ').toLowerCase();
    if (!normalized) return false;
    let matches = 0;
    for (const message of (messages || []).slice(-8)) {
      if (message?.senderKind !== 'agent') continue;
      const candidate = cleanText(message.text).replace(/\s+/g, ' ').toLowerCase();
      if (candidate === normalized) matches += 1;
    }
    return matches >= threshold;
  }

  const api = {
    DONE_TOKEN,
    USER_TOKEN,
    NOTE_TOKEN,
    CONTROL_TOKENS,
    DEFAULT_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_MESSAGE_CHARS,
    NESTED_RELAY_OMISSION,
    MESSAGE_SHORTENED,
    cleanName,
    cleanText,
    clampInt,
    MAX_RELAY_TURNS,
    PROVIDER_CONTROL_ACTIONS,
    trailingProviderCommand,
    trailingHandoff,
    messageWrapper,
    parseAgentReply,
    relayDisposition,
    collapseNestedRelay,
    projectContextText,
    projectedMessageBlock,
    boundedContext,
    buildRelayPrompt,
    nextMemberIndex,
    isRepeatedReply
  };

  globalThis.BrowserAiBridgeDexProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();