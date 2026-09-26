const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TARGET_PREFIX, isInteractiveAgyProcess, targetFromProcess, listTargets, pidFromTarget,
  cleanScreenLine, cleanReplyLines, looksReadyForInput, extractVisibleReply, mergeVisibleReply,
  sendToProcess, isSafePasteCandidate, writeInboxPayload, removeInboxPayload, pruneInbox,
  isTerminalWidgetLine, sendPrompt, findPromptResponseStart
} = require('../local-targets/antigravity-existing');

test('existing-session discovery excludes bridge-managed/headless agy processes', () => {
  assert.equal(isInteractiveAgyProcess({ CommandLine: 'C:\\agy.exe' }), true);
  assert.equal(isInteractiveAgyProcess({ CommandLine: 'C:\\agy.exe --input-format stream-json --output-format stream-json' }), false);
  assert.equal(isInteractiveAgyProcess({ CommandLine: 'C:\\agy.exe -p "hello" --output-format json' }), false);
  assert.equal(isInteractiveAgyProcess({ CommandLine: 'C:\\agy.exe remote-control start --session' }), false);
  assert.equal(isInteractiveAgyProcess({ CommandLine: 'C:\\agy.exe --remote-control' }), false);
});

test('existing target metadata is explicitly classified as an attached Existing Session', () => {
  const target = targetFromProcess({
    ProcessId: 4242, ParentProcessId: 4000, ExecutablePath: 'C:\\Users\\Drift\\agy.exe', CommandLine: 'agy.exe'
  }, { ok: true, processes: [4242, 4000] });

  assert.equal(target.id, `${TARGET_PREFIX}4242`);
  assert.equal(target.sessionOrigin, 'existing');
  assert.equal(target.transport, 'windows-console-attach');
  assert.equal(target.pid, 4242);
  assert.match(target.title, /Existing Session/);
  assert.deepEqual(target.consoleProcesses, [4242, 4000]);
  assert.equal(pidFromTarget(target.id), 4242);
});

test('listTargets only exposes running agy terminals that pass AttachConsole probe', async () => {
  const targets = await listTargets({
    platform: 'win32',
    discoverImpl: () => [{ ProcessId: 11, CommandLine: 'agy.exe' }, { ProcessId: 22, CommandLine: 'agy.exe' }],
    probeImpl: (pid) => pid === 22 ? { ok: true, processes: [22] } : { ok: false, error: 'no console' }
  });
  assert.deepEqual(targets.map((target) => target.pid), [22]);
});

test('Windows Terminal right-border cells are removed without stripping real punctuation', () => {
  assert.equal(cleanScreenLine('Loud and clear!                         ?'), 'Loud and clear!');
  assert.equal(cleanScreenLine('Existing Session is live.              │'), 'Existing Session is live.');
  assert.equal(cleanScreenLine('Divider line with backtick             `'), 'Divider line with backtick');
  assert.equal(cleanScreenLine('                                      ?'), '');
  assert.equal(cleanScreenLine('What is next?'), 'What is next?');
  assert.equal(cleanScreenLine('?'), '?');
});

test('ready detection requires an empty Antigravity prompt and rejects busy/draft state', () => {
  assert.equal(looksReadyForInput('stuff\n>\n? for shortcuts'), true);
  assert.equal(looksReadyForInput('stuff\n>                       ?\n? for shortcuts'), true);
  assert.equal(looksReadyForInput('stuff\n> unsent draft\n? for shortcuts'), false);
  assert.equal(looksReadyForInput('stuff\n> unsent draft          ?\n? for shortcuts'), false);
  assert.equal(looksReadyForInput('Working...\nGemini 3.8 Flash · high'), false);
  assert.equal(looksReadyForInput('stuff\n>\nesc to cancel · Gemini 3.8 Flash · high'), false);
  assert.equal(looksReadyForInput('stuff\n>                       ?\nesc to cancel · Gemini 3.8 Flash · high?'), false);
});

test('visible reply extraction returns the assistant block after the injected prompt', () => {
  const before = 'Earlier conversation\n\n>\n? for shortcuts              Gemini 3.8 Flash · high';
  const after = 'Earlier conversation\n\n> hello bridge\nLoud and clear.\nSame running terminal.\n\n>\n? for shortcuts              Gemini 3.8 Flash · high';
  assert.equal(extractVisibleReply(before, after, 'hello bridge'), 'Loud and clear.\nSame running terminal.');
});

const defaultBefore = 'Earlier\n>                       ?\n? for shortcuts';

test('visible reply extraction removes right-edge border artifacts from every response line', () => {
  const after = '> hi? from tool                              ?\nLoud and clear! Astro is right here.         ?\n                                             ?\nI see your message arriving here.            ?\nWhat is our next move?                       ?\n>                                            ?\n? for shortcuts              Gemini 3.8 Flash · high?';
  assert.equal(
    extractVisibleReply(defaultBefore, after, 'hi? from tool'),
    'Loud and clear! Astro is right here.\n\nI see your message arriving here.\nWhat is our next move?'
  );
});

test('visible reply extraction does not truncate when assistant quotes the user prompt', () => {
  const after = '> hi? from tool                              ?\nLoud and clear! Astro is right here.         ?\n                                             ?\nI see your message **"hi? from tool"**       ?\narriving directly in this terminal session.  ?\nWhat is our next move?                       ?\n>                                            ?\n? for shortcuts              Gemini 3.8 Flash · high?';
  assert.equal(
    extractVisibleReply(defaultBefore, after, 'hi? from tool'),
    'Loud and clear! Astro is right here.\n\nI see your message **"hi? from tool"**\narriving directly in this terminal session.\nWhat is our next move?'
  );
});

test('visible reply extraction strips tip banners and working status lines', () => {
  const after = '> Hello, from tool 1 more time                ?\nLoud and clear! Astro is right here.         ?\n                                             ?\nReceived your message:                       ?\n"Hello, from tool 1 more time"               ?\n?  Working...                                ?\n└ Tip: Press esc to interrupt generation.     ?\n>                                            ?\n? for shortcuts              Gemini 3.8 Flash · high?';
  assert.equal(
    extractVisibleReply(defaultBefore, after, 'Hello, from tool 1 more time'),
    'Loud and clear! Astro is right here.\n\nReceived your message:\n"Hello, from tool 1 more time"'
  );
});

test('cleanReplyLines strips prompt divider boxes with trailing backticks and empty prompt lines', () => {
  const lines = [
    '----------------------------------------------------`',
    '>                                                   `',
    '----------------------------------------------------`',
    'Loud and clear from the tool!',
    'Direct console input path verified.'
  ];
  assert.deepEqual(
    cleanReplyLines(lines),
    ['Loud and clear from the tool!', 'Direct console input path verified.']
  );
});

test('long wrapped browser prompts are excluded from the captured reply', () => {
  const prompt = 'this is what the tool shows, [POC · MULTI-ORIGIN AI TARGET BRIDGE Nexus Browser Local bridge ready Target class Local-Origin Targets Target type Terminal Agent] what do you think?';
  const after = '> this is what the tool shows, [POC · MULTI-ORIGIN ?\nAI TARGET BRIDGE Nexus Browser Local bridge   ?\nready Target class Local-Origin Targets Target    ?\ntype Terminal Agent] what do you think?            ?\n                                                   ?\nLocal terminal agent bridge is established.       ?\nThe long browser prompt is not part of this reply. ?\n?  Working...                                      ?\n+ Tip: Use /model to switch available models      ?\n>                                                  ?\n? for shortcuts              Gemini 3.8 Flash · high?';
  assert.equal(
    extractVisibleReply(defaultBefore, after, prompt),
    'Local terminal agent bridge is established.\nThe long browser prompt is not part of this reply.'
  );
});

test('reply extraction can continue from the previous partial after the prompt scrolls away', () => {
  const current = 'Middle of reply.\nFinal response line.\n>\n? for shortcuts              Gemini 3.8 Flash · high';
  assert.equal(
    extractVisibleReply('Earlier\n>\n? for shortcuts', current, 'a very long prompt no longer visible', 'First response line.\nMiddle of reply.'),
    'Middle of reply.\nFinal response line.'
  );
});

test('long prompt transport uses helper stdin rather than a Windows command-line argument', () => {
  const text = `${'αβγ long prompt '.repeat(3000)}END`;
  let call = null;
  const result = sendToProcess(4242, text, {
    spawnSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return { status: 0, stdout: '{"ok":true,"pid":4242,"eventsWritten":2}', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.ok(call);
  assert.equal(call.args.includes('-Text'), false);
  assert.equal(call.args.some((arg) => arg === text), false);
  assert.equal(Buffer.from(call.options.input, 'base64').toString('utf8'), text);
});

test('reply merging preserves lines that scroll out of the visible terminal viewport', () => {
  const first = 'Loud and clear!\nI see your message arriving\ndirectly in this terminal session.';
  const second = 'directly in this terminal session.\n\nExisting Session is fully qualified.\nWhat is our next move?';
  assert.equal(
    mergeVisibleReply(first, second),
    'Loud and clear!\nI see your message arriving\ndirectly in this terminal session.\n\nExisting Session is fully qualified.\nWhat is our next move?'
  );
});

test('existing-session send writes into the same terminal and accumulates scrolled reply snapshots', async () => {
  const snapshots = [
    { ok: true, text: 'Earlier\n>                       ?\n? for shortcuts' },
    { ok: true, text: '> hello bridge                            ?\nLoud and clear.                          ?\nSame running terminal.                   ?' },
    { ok: true, text: 'Same running terminal.                   ?\nFinal line survives scrolling.           ?\n>                                        ?\n? for shortcuts        Gemini 3.8 Flash · high?' }
  ];
  const sends = [];
  const emitted = [];
  let clock = 0;
  const code = await sendPrompt({
    requestId: 'existing-1',
    text: 'hello bridge',
    target: { id: `${TARGET_PREFIX}4242`, pid: 4242, providerId: 'local-antigravity-existing', providerName: 'Antigravity CLI' },
    emit: (event) => emitted.push(event),
    snapshotImpl: () => snapshots.shift() || { ok: true, text: 'Same running terminal.\nFinal line survives scrolling.\n>\n? for shortcuts' },
    sendImpl: (pid, text) => { sends.push({ pid, text }); return { ok: true }; },
    sleepImpl: async () => {},
    nowImpl: () => ++clock,
    timeoutMs: 50,
    pollMs: 0,
    stableMs: 0
  });
  assert.equal(code, 0);
  assert.deepEqual(sends, [{ pid: 4242, text: 'hello bridge' }]);
  const final = emitted.find((event) => event.type === 'response_final');
  assert.ok(final);
  assert.equal(final.text, 'Loud and clear.\nSame running terminal.\nFinal line survives scrolling.');
  assert.equal(final.attachedPid, 4242);
});

test('existing-session send refuses a terminal with an unsent draft', async () => {
  await assert.rejects(
    sendPrompt({
      requestId: 'draft',
      text: 'do not inject',
      target: { id: `${TARGET_PREFIX}4242`, pid: 4242 },
      snapshotImpl: () => ({ ok: true, text: '> my unfinished draft\n? for shortcuts' }),
      sendImpl: () => { throw new Error('must not send'); },
      readyTimeoutMs: 20,
      readyPollMs: 0
    }),
    /timed out waiting for an empty prompt/i
  );
});

test('long Unicode stress prompt (30k chars) is delivered via stdin base64 without command-line flags', () => {
  const chunk = 'αβγ 日本語 ✓ [payload] {"key": "val & <tag> \'quote\'"} ';
  const text = 'LONG_PROMPT_BEGIN_99173 ' + chunk.repeat(Math.ceil(30000 / chunk.length)).slice(0, 30000) + ' LONG_PROMPT_END_99173';
  let call = null;
  const result = sendToProcess(4242, text, {
    spawnSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return { status: 0, stdout: '{"ok":true,"pid":4242,"eventsWritten":60000}', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.ok(call);
  assert.equal(call.args.includes('-Text'), false);
  assert.equal(call.args.some((arg) => arg.includes('LONG_PROMPT')), false);
  assert.equal(Buffer.from(call.options.input, 'base64').toString('utf8'), text);
});

test('narrow terminal wrapped prompt with sentinels isolates assistant reply with zero leaks', () => {
  const prompt = 'LONG_PROMPT_BEGIN_99173 Analyze this bridge payload and report status. LONG_PROMPT_END_99173';
  const before = 'Earlier conversation\n>                       ?\n? for shortcuts';
  const after = [
    '> LONG_PROMPT_BEGIN_99173 Analyze this bridge      ?',
    'payload and report status.                         ?',
    'LONG_PROMPT_END_99173                              ?',
    '                                                   ?',
    'LONG_REPLY_FIRST: Terminal bridge is active.       ?',
    'LONG_REPLY_SECOND: Full qualification in progress. ?',
    'LONG_REPLY_LAST: All checks passed.                ?',
    '?  Working...                                      ?',
    '+ Tip: Use /model to switch between models        ?',
    '---------------------------------------------------?',
    '>                                                 ?',
    '? for shortcuts              Gemini 3.8 Flash · high?'
  ].join('\n');

  const reply = extractVisibleReply(before, after, prompt);
  assert.equal(
    reply,
    'LONG_REPLY_FIRST: Terminal bridge is active.\nLONG_REPLY_SECOND: Full qualification in progress.\nLONG_REPLY_LAST: All checks passed.'
  );
  assert.equal(reply.includes('LONG_PROMPT'), false);
  assert.equal(reply.includes('Working...'), false);
  assert.equal(reply.includes('Tip:'), false);
  assert.equal(reply.includes('for shortcuts'), false);
});

test('multi-stage scrolling stitches partial replies across 3 snapshots without duplication', () => {
  const prompt = 'LONG_PROMPT_BEGIN_99173 Start multi-stage stream LONG_PROMPT_END_99173';
  const before = 'Earlier\n>\n? for shortcuts';
  const snap1 = '> LONG_PROMPT_BEGIN_99173 Start multi-stage stream ?\nLONG_PROMPT_END_99173                              ?\nPART_1: Initial tokens.                            ?\nPART_2: Generation continuing...                   ?';
  const snap2 = 'PART_2: Generation continuing...                   ?\nPART_3: Buffer scrolled past prompt.               ?\nPART_4: Middle section captured.                   ?';
  const snap3 = 'PART_4: Middle section captured.                   ?\nPART_5: Final tokens arrived.                      ?\nFINAL: Done.                                       ?\n>                                                  ?\n? for shortcuts             Gemini 3.8 Flash · high?';

  const r1 = extractVisibleReply(before, snap1, prompt);
  const r2 = extractVisibleReply(before, snap2, prompt, r1);
  const m1_2 = mergeVisibleReply(r1, r2);
  const r3 = extractVisibleReply(before, snap3, prompt, m1_2);
  const final = mergeVisibleReply(m1_2, r3);

  assert.equal(
    final,
    'PART_1: Initial tokens.\nPART_2: Generation continuing...\nPART_3: Buffer scrolled past prompt.\nPART_4: Middle section captured.\nPART_5: Final tokens arrived.\nFINAL: Done.'
  );
});

test('reply extraction recovers visible reply when prompt and thought block scroll off buffer before initial poll', () => {
  const before = Array.from({ length: 29 }, (_, i) => `Previous conversation line ${i}`).join('\n');
  const current = '? Thought for 6s, 1.8k tokens\n  thinking process...\n\n**Yes, 100%.**\nWhen you type in the Nexus Browser UI and click send:\n1. Zero separate instances: It attaches to the live terminal.\n2. True bi-directional link: Keystrokes injected into CONIN$.\n3. Full context retention: Shared memory and workspace.\n----------------------------------------------------\n>\n----------------------------------------------------\n? for shortcuts              Gemini 3.8 Flash · high';

  const reply = extractVisibleReply(before, current, 'test so this site is connected to terminal now?', '');
  assert.equal(
    reply,
    [
      '**Yes, 100%.**',
      'When you type in the Nexus Browser UI and click send:',
      '1. Zero separate instances: It attaches to the live terminal.',
      '2. True bi-directional link: Keystrokes injected into CONIN$.',
      '3. Full context retention: Shared memory and workspace.'
    ].join('\n')
  );
});

test('reply merging appends disjoint sequential chunks when output scrolls past buffer without overlap', () => {
  const first = '### Section 1\nContent of section 1.\n\n### Section 2\nContent of section 2.';
  const second = '### Section 3\nContent of section 3.\n\n### Section 4\nFinal content.';
  assert.equal(
    mergeVisibleReply(first, second),
    `${first}\n\n${second}`
  );
});

test('findPreviousReplyStart rejects repeated divider lines and anchors on distinctive text', () => {
  const previous = '#### Section 1\nContent 1.\n------\n#### Section 2\nContent 2.\n------\n#### Section 3\nIdentity Protection details.\n------';
  const current = 'Identity Protection details.\n------\n#### Section 4\nContent 4.\n------\n#### Section 5\nQualification complete.\n------\nEnd of transmission.\n? Loading...';
  const reply = extractVisibleReply('Earlier\n>\n? for shortcuts', current, 'prompt that scrolled away', previous);
  const merged = mergeVisibleReply(previous, reply);
  assert.equal(merged.includes('Section 4'), true);
  assert.equal(merged.includes('Section 5'), true);
  assert.equal(merged.includes('End of transmission.'), true);
  assert.equal(merged.includes('Loading...'), false);
});

test('isSafePasteCandidate detects multiline, code fences, and long prompt payloads', () => {
  assert.equal(isSafePasteCandidate('hello world'), false);
  assert.equal(isSafePasteCandidate('line 1\nline 2'), true);
  assert.equal(isSafePasteCandidate('some text ```code``` more text'), true);
  assert.equal(isSafePasteCandidate('a'.repeat(1500)), true);
});

test('writeInboxPayload writes exact UTF-8 content and returns absolute normalized path', () => {
  const writes = [];
  const fakeFs = { existsSync: () => true, writeFileSync: (f, c, e) => writes.push({ f, c, e }) };
  const abs = writeInboxPayload('req-123/bad!', 'Exact\nPayload\n```js\n1```', {
    inboxDir: 'C:\\fake\\.browser-ai-bridge\\inbox', fsImpl: fakeFs
  });
  assert.equal(abs, path.resolve('C:\\fake\\.browser-ai-bridge\\inbox', 'req-123_bad_.md'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].c, 'Exact\nPayload\n```js\n1```');
  assert.equal(writes[0].e, 'utf8');
});

test('Safe Paste instruction uses quoted absolute path resolving identically from any CWD', () => {
  const payload = path.resolve(__dirname, '..', '.browser-ai-bridge', 'inbox', 'cwd-test.md');
  [path.resolve(__dirname, '..', '..'), path.resolve(__dirname, '..'), path.resolve(__dirname)].forEach((cwd) => {
    assert.equal(path.resolve(cwd, payload), payload);
  });
});

test('existing-session send routes large prompts with quoted absolute path and unlinks payload', async () => {
  const writes = [], sends = [], unlinks = [], prunes = [];
  const absPath = path.resolve('C:\\fake\\.browser-ai-bridge\\inbox\\safe-1.md');
  let clock = 0;
  await sendPrompt({
    requestId: 'safe-1', text: 'Multi\nLine\n```test```',
    target: { id: `${TARGET_PREFIX}4242`, pid: 4242, providerId: 'local-antigravity-existing', providerName: 'Antigravity CLI' },
    snapshotImpl: () => ({ ok: true, text: 'Earlier\n>\n? for shortcuts' }),
    sendImpl: (pid, text) => { sends.push({ pid, text }); return { ok: true }; },
    inboxWriterImpl: (reqId, raw) => { writes.push({ reqId, raw }); return absPath; },
    inboxCleanerImpl: (p) => unlinks.push(p), inboxPrunerImpl: (dir) => prunes.push(dir),
    sleepImpl: async () => {}, nowImpl: () => ++clock, timeoutMs: 0
  });
  assert.equal(prunes.length, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(sends, [{
    pid: 4242,
    text: `Read "${absPath}" as my exact user message. Preserve its formatting and respond to its contents.`
  }]);
  assert.deepEqual(unlinks, [absPath]);
});

test('failure cleanup policy unlinks on error by default and retains when retainOnError is true', async () => {
  const unlinks = [];
  const absPath = 'C:\\fake\\.browser-ai-bridge\\inbox\\err-1.md';
  await sendPrompt({
    requestId: 'err-1', text: 'Multi\nLine\n```test```', target: { id: `${TARGET_PREFIX}4242`, pid: 4242 },
    snapshotImpl: () => ({ ok: true, text: 'Earlier\n>\n? for shortcuts' }),
    sendImpl: () => ({ ok: false, error: 'fail' }),
    inboxWriterImpl: () => absPath, inboxCleanerImpl: (p) => unlinks.push(p),
    sleepImpl: async () => {}, nowImpl: () => Date.now(), timeoutMs: 0
  }).catch(() => {});
  assert.deepEqual(unlinks, [absPath], 'default unlinks on error');

  unlinks.length = 0;
  await sendPrompt({
    requestId: 'err-2', text: 'Multi\nLine\n```test```', target: { id: `${TARGET_PREFIX}4242`, pid: 4242 },
    snapshotImpl: () => ({ ok: true, text: 'Earlier\n>\n? for shortcuts' }),
    sendImpl: () => ({ ok: false, error: 'fail' }),
    inboxWriterImpl: () => absPath, inboxCleanerImpl: (p) => unlinks.push(p), retainOnError: true,
    sleepImpl: async () => {}, nowImpl: () => Date.now(), timeoutMs: 0
  }).catch(() => {});
  assert.deepEqual(unlinks, [], 'retains on error when retainOnError is true');
});

test('pruneInbox removes stale md payloads while preserving fresh and unrelated files', () => {
  const unlinks = [];
  const fakeFs = {
    existsSync: () => true,
    readdirSync: () => ['stale.md', 'fresh.md', 'keep.json', 'notes.txt'],
    statSync: (file) => ({ mtimeMs: file.includes('stale') ? (Date.now() - 100000) : Date.now() }),
    unlinkSync: (file) => unlinks.push(file)
  };
  pruneInbox('C:\\fake\\inbox', { maxAgeMs: 50000, fsImpl: fakeFs });
  assert.equal(unlinks.length, 1);
  assert.match(unlinks[0], /stale\.md$/);
});

test('isTerminalWidgetLine strips TUI widgets but preserves legitimate English prose', () => {
  ['? Reading file...', '? Running command...', '● Read(~/test.md) (ctrl+o to expand)', '○ Bash(node -e "...") (ctrl+o to expand)', 'expand)', '⣯  Running command...', '▸ Thought for 2s', '? Thought for 2s', '?  Safe paste transport seems operational. User i...?'].forEach((line) => {
    assert.equal(isTerminalWidgetLine(line), true, `widget line expected: ${line}`);
  });
  ['Running tests locally is the safest option.', 'Reading this file shows three problems.', 'Thinking through the architecture, I would keep this design.', 'Loading configuration from disk is expected behavior.', 'Searching code for references.', 'Executing this query will return rows.'].forEach((line) => {
    assert.equal(isTerminalWidgetLine(line), false, `prose line expected: ${line}`);
  });
});

test('visible reply extraction strips tool widgets, reading banners, and thought previews', () => {
  const after = '> Read "C:\\test\\inbox\\test.md"\n----------------------------------------------------?\n? Read(~/Downloads/test.md) (ctrl+o to expand)\n?  Reading file...\n\n? Thought for 2s\n  Safe paste transport seems operational. User i...\nNot breaking at all - Safe Paste executed flawlessly!\n\n>\n? for shortcuts              Gemini 3.8 Flash · high';
  assert.equal(extractVisibleReply(defaultBefore, after, 'Read "C:\\test\\inbox\\test.md"'), 'Not breaking at all - Safe Paste executed flawlessly!');
});

test('extractVisibleReply isolates reply when prompt wraps with short initial line', () => {
  const prompt = 'Read "C:\\test\\inbox\\payload.md" as my exact user message. Preserve its formatting and respond to its contents.';
  const current = [
    'Previous turn assistant output.',
    '─────────────────────────────────────────────────',
    '> Read',
    '  "C:\\test\\inbox\\payload.md" as my exact user',
    '  message. Preserve its formatting and respond to',
    '  its contents.',
    '─────────────────────────────────────────────────',
    'Assistant response for payload arrived cleanly.',
    '>',
    '? for shortcuts              Gemini 3.8 Flash · high'
  ].join('\n');
  assert.equal(
    extractVisibleReply('Previous turn assistant output.\n>\n? for shortcuts', current, prompt),
    'Assistant response for payload arrived cleanly.'
  );
});

test('reply merging stitches streaming partial lines without duplicating preceding content', () => {
  const previous = '1. First step.\n2. Second step.\n3. Session Handshake: A single 105-character\n  comm';
  const next = '3. Session Handshake: A single 105-character\n  command arrived in this terminal:\n4. Final step.';
  assert.equal(mergeVisibleReply(previous, next), '1. First step.\n2. Second step.\n3. Session Handshake: A single 105-character\n  command arrived in this terminal:\n4. Final step.');
});

test('reply merging stitches offset head and completes partial lines across stream jumps', () => {
  const previous = 'header\n[Nexus Browser Client]\n[isSafePasteCandidate Check]\n  +-- Short Single-Line (<1500 chars, no\nfences) --? Direct CONIN$ Injection\n  +-- Multiline / Fe';
  const next = 'Something above\n[isSafePasteCandidate Check]\n  +-- Short Single-Line (<1500 chars, no\nfences) --? Direct CONIN$ Injection\n  +-- Multiline / Fenced (>=1500 chars) --? Safe Paste\nMore content';
  assert.equal(
    mergeVisibleReply(previous, next),
    'header\n[Nexus Browser Client]\n[isSafePasteCandidate Check]\n  +-- Short Single-Line (<1500 chars, no\nfences) --? Direct CONIN$ Injection\n  +-- Multiline / Fenced (>=1500 chars) --? Safe Paste\nMore content'
  );
});

test('extractVisibleReply isolates reply when prompt head scrolled off leaving continuation tail', () => {
  const prompt = 'Read "C:\\test\\inbox\\payload.md" as my exact user message. Preserve its formatting and respond to its contents.';
  const current = [
    '  "C:\\test\\inbox\\payload.md" as my exact user',
    '  message. Preserve its formatting and respond to',
    '  its contents.',
    '───────────────────────────────────────────────',
    '? Read(~/Downloads/test.md) (ctrl+o to expand)',
    '?  Reading file...',
    '? Thought for 2s',
    '  Safe paste transport seems operational...',
    'Actual reply starts here.',
    '>',
    '? for shortcuts              Gemini 3.8 Flash · high'
  ].join('\n');
  assert.equal(extractVisibleReply('Previous turn assistant output.\n>\n? for shortcuts', current, prompt), 'Actual reply starts here.');
});

