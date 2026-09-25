const test = require('node:test');
const assert = require('node:assert/strict');
const chatgptInput = require('../extension/content/chatgpt-input.js');
const chatgpt = require('../extension/content/chatgpt.js');

function control({ id = '', aria = '', testId = '', type = '', disabled = false, title = '' } = {}) {
  return {
    id,
    disabled,
    className: '',
    textContent: '',
    getAttribute(name) {
      if (name === 'aria-label') return aria;
      if (name === 'data-testid') return testId;
      if (name === 'type') return type;
      if (name === 'title') return title;
      if (name === 'aria-disabled') return disabled ? 'true' : null;
      return null;
    },
    matches(selector) {
      return selector.includes('button');
    }
  };
}

test('ChatGPT composer selector chain includes the current prompt-textarea and fallback textarea', () => {
  const selectors = chatgptInput.composerSelectors();
  assert.equal(selectors.includes('#prompt-textarea[contenteditable="true"]'), true);
  assert.equal(selectors.includes('textarea[name="prompt-textarea"]'), true);
  assert.equal(selectors.includes('textarea[name="prompt"]'), true);
});

test('ChatGPT known send controls score strongly', () => {
  assert.ok(chatgptInput.sendControlScore(control({ id: 'composer-submit-button', aria: 'Send prompt' })) >= 500);
  assert.ok(chatgptInput.sendControlScore(control({ testId: 'send-button' })) >= 250);
  assert.ok(chatgptInput.sendControlScore(control({ testId: 'fruitjuice-send-button' })) >= 200);
  assert.ok(chatgptInput.sendControlScore(control({ aria: 'Send' })) >= 150);
});

test('ChatGPT voice/dictation controls can never score as send', () => {
  assert.equal(chatgptInput.sendControlScore(control({ aria: 'Start dictation' })), -1000);
  assert.equal(chatgptInput.sendControlScore(control({ aria: 'Start Voice' })), -1000);
  assert.equal(chatgptInput.sendControlScore(control({ aria: 'Upload file' })), -1000);
});

test('ChatGPT disabled send controls are rejected', () => {
  assert.equal(chatgptInput.sendControlScore(control({ testId: 'send-button', disabled: true })), -1000);
});


test('ChatGPT generation detection recognizes current stop-streaming controls', () => {
  const stop = control({ aria: 'Stop streaming' });
  const root = {
    querySelectorAll(selector) {
      return selector === 'button[aria-label="Stop streaming"]' ? [stop] : [];
    }
  };
  assert.equal(chatgptInput.generationLooksActive(root), true);
});

test('ChatGPT generation detection ignores an idle document with no busy or stop control', () => {
  const root = { querySelectorAll() { return []; } };
  assert.equal(chatgptInput.generationLooksActive(root), false);
});


test('ChatGPT ready-composer wait tolerates initial hydration with no composer', async () => {
  const hydrated = { value: '' };
  const send = {};
  const original = {
    findComposer: chatgptInput.findComposer,
    findSendControl: chatgptInput.findSendControl,
    setComposerText: chatgptInput.setComposerText,
    composerContainsText: chatgptInput.composerContainsText
  };
  let calls = 0;
  try {
    chatgptInput.findComposer = () => (++calls < 3 ? null : hydrated);
    chatgptInput.findSendControl = (field) => field === hydrated && field.value === 'payload' ? send : null;
    chatgptInput.setComposerText = (field, text) => { field.value = text; };
    chatgptInput.composerContainsText = (field, text) => !!field && field.value === text;
    const ready = await chatgpt.waitForReadyComposer(null, 'payload', 300);
    assert.equal(ready.composer, hydrated);
    assert.equal(ready.control, send);
    assert.equal(hydrated.value, 'payload');
  } finally {
    Object.assign(chatgptInput, original);
  }
});

test('ChatGPT Dex result delivery follows a remounted composer before submit', async () => {
  const first = { value: 'payload' };
  const second = { value: '' };
  const send = {};
  const original = {
    findComposer: chatgptInput.findComposer,
    findSendControl: chatgptInput.findSendControl,
    setComposerText: chatgptInput.setComposerText,
    composerContainsText: chatgptInput.composerContainsText
  };
  let calls = 0;
  try {
    chatgptInput.findComposer = () => (++calls < 2 ? first : second);
    chatgptInput.findSendControl = (field) => field === second && field.value === 'payload' ? send : null;
    chatgptInput.setComposerText = (field, text) => { field.value = text; };
    chatgptInput.composerContainsText = (field, text) => field.value === text;
    const ready = await chatgpt.waitForReadyComposer(first, 'payload', 250);
    assert.equal(ready.composer, second);
    assert.equal(ready.control, send);
    assert.equal(second.value, 'payload');
    assert.ok(chatgpt.DEX_CONTROL_SEND_WAIT_MS >= 12000);
  } finally {
    chatgptInput.findComposer = original.findComposer;
    chatgptInput.findSendControl = original.findSendControl;
    chatgptInput.setComposerText = original.setComposerText;
    chatgptInput.composerContainsText = original.composerContainsText;
  }
});

test('ChatGPT treats a committed user turn as submission success even if composer text lingers', async () => {
  const field = { value: 'payload', closest() { return null; } };
  let clicks = 0;
  const originalContains = chatgptInput.composerContainsText;
  try {
    chatgptInput.composerContainsText = (composer, text) => composer.value === text;
    const mode = await chatgpt.submitComposer(
      field,
      'payload',
      { click() { clicks += 1; } },
      { exactOnce: true, isCommitted: () => clicks === 1 }
    );
    assert.equal(mode, 'click');
    assert.equal(clicks, 1);
    assert.equal(field.value, 'payload');
  } finally {
    chatgptInput.composerContainsText = originalContains;
  }
});


test('Dex send targets the active composer form, not an unrelated visible Send button', () => {
  const foreign = control({ id: 'composer-submit-button', aria: 'Send prompt' });
  const local = control({ testId: 'send-button' });
  const form = { querySelectorAll() { return [local]; } };
  const composer = { closest(selector) { return selector === 'form' ? form : null; } };
  const old = global.document;
  global.document = { querySelectorAll() { return [foreign]; } };
  try { assert.equal(chatgptInput.findSendControl(composer), local); }
  finally { global.document = old; }
});
test('Dex send cannot reach a foreign Send button while its own form is hydrating', () => {
  const form = { querySelectorAll() { return []; } };
  const composer = { closest() { return form; } };
  const old = global.document;
  global.document = { querySelectorAll() { return [control({ testId: 'send-button' })]; } };
  try { assert.equal(chatgptInput.findSendControl(composer), null); }
  finally { global.document = old; }
});
test('Dex prompt hydration refuses to overwrite a different draft', async () => {
  const draft = { tagName: 'TEXTAREA', value: 'my unsent draft' };
  const previous = chatgptInput.findComposer;
  chatgptInput.findComposer = () => draft;
  try {
    await assert.rejects(chatgpt.waitForReadyComposer(draft, 'Dex message', 100),
      /different draft/);
    assert.equal(draft.value, 'my unsent draft');
  } finally { chatgptInput.findComposer = previous; }
});
test('uncertain Send click never triggers form or Enter fallback and leaves draft intact', async () => {
  const field = { tagName: 'TEXTAREA', value: 'Dex message', closest() { return form; } };
  let clicks = 0, submits = 0;
  const form = { requestSubmit() { submits++; } };
  const prior = chatgptInput.composerContainsText;
  chatgptInput.composerContainsText = (composer, text) => composer.value === text;
  try {
    await assert.rejects(chatgpt.submitComposer(field, 'Dex message', { click() { clicks++; } },
      { exactOnce: true, isCommitted: () => false }), /unconfirmed/);
    assert.equal(clicks, 1);
    assert.equal(submits, 0);
    assert.equal(field.value, 'Dex message');
  } finally { chatgptInput.composerContainsText = prior; }
});
test('no Send button uses native form requestSubmit once and confirms departure', async () => {
  let submits = 0; const form = { requestSubmit() { submits++; field.value = ''; } };
  const field = { tagName: 'TEXTAREA', value: 'Dex message', closest() { return form; } };
  const prior = chatgptInput.composerContainsText;
  chatgptInput.composerContainsText = (composer, text) => composer.value === text;
  try {
    assert.equal(await chatgpt.submitComposer(field, 'Dex message', null,
      { exactOnce: true }), 'requestSubmit');
    assert.equal(submits, 1);
  } finally { chatgptInput.composerContainsText = prior; }
});

test('remounted ChatGPT composer must actually empty before a Dex send is acknowledged', async () => {
  const former = { tagName: 'TEXTAREA', value: 'Dex return' };
  const current = { tagName: 'TEXTAREA', value: 'Dex return' };
  const priorFind = chatgptInput.findComposer, oldDocument = global.document;
  let clicked = 0;
  global.document = {};
  chatgptInput.findComposer = () => current;
  try {
    await assert.rejects(chatgpt.submitComposer(former, 'Dex return', {
      click() { clicked++; former.value = ''; }
    }, { exactOnce: true, isCommitted: () => false }), /unconfirmed/);
    assert.equal(clicked, 1);
    assert.equal(current.value, 'Dex return', 'the unsent remounted draft must be preserved');
  } finally {
    chatgptInput.findComposer = priorFind;
    global.document = oldDocument;
  }
});

function composerScope({ buttons = [], editors = [] } = {}) {
  return {
    tagName: 'DIV', parentElement: null,
    querySelectorAll(selector) {
      if (selector === 'input, textarea, [contenteditable="true"]') return editors;
      if (selector === 'button, [role="button"]') return buttons;
      if (selector.includes('send-button')) return buttons.filter(button =>
        button.getAttribute?.('data-testid')?.includes('send-button'));
      if (selector === '#composer-submit-button') return buttons.filter(button => button.id === 'composer-submit-button');
      if (selector.includes('aria-label')) return buttons.filter(button => /send/i.test(button.getAttribute?.('aria-label') || ''));
      return [];
    }
  };
}

test('form-less ChatGPT finds its real Send in an outer sibling actions bar', () => {
  const send = control({ testId: 'send-button', aria: 'Send prompt' });
  const composer = Object.assign(composerScope(), {
    id: 'prompt-textarea', isContentEditable: true, closest: () => null
  });
  const inner = composerScope({ editors: [composer] });
  const scroll = composerScope({ editors: [composer] });
  const boundary = composerScope({ editors: [composer] });
  const actionsBarOwner = composerScope({ buttons: [send], editors: [composer] });
  const body = composerScope({ buttons: [control({ id: 'composer-submit-button' })], editors: [composer] });
  composer.parentElement = inner;
  inner.parentElement = scroll;
  scroll.parentElement = boundary;
  boundary.parentElement = actionsBarOwner;
  actionsBarOwner.parentElement = body;
  body.tagName = 'BODY';
  const old = global.document;
  global.document = { body, querySelectorAll() { throw new Error('Never search document-wide buttons'); } };
  try { assert.equal(chatgptInput.findSendControl(composer), send); }
  finally { global.document = old; }
});

test('form-less composer refuses a Send button in a shared ancestor containing another editor', () => {
  const send = control({ testId: 'send-button' });
  const composer = Object.assign(composerScope(), { isContentEditable: true, closest: () => null });
  const foreign = Object.assign(composerScope(), { isContentEditable: true });
  const inner = composerScope({ editors: [composer] });
  const shared = composerScope({ buttons: [send], editors: [composer, foreign] });
  composer.parentElement = inner; inner.parentElement = shared;
  const old = global.document;
  global.document = { querySelectorAll() { return [send]; } };
  try { assert.equal(chatgptInput.findSendControl(composer), null); }
  finally { global.document = old; }
});

test('form-less Send lookup rejects disabled or voice-only controls without unsafe global fallback', () => {
  const composer = Object.assign(composerScope(), { isContentEditable: true, closest: () => null });
  const actions = composerScope({
    buttons: [control({ testId: 'send-button', disabled: true }), control({ aria: 'Start Voice' })],
    editors: [composer]
  });
  composer.parentElement = actions;
  const old = global.document;
  global.document = { querySelectorAll() { return [control({ testId: 'send-button' })]; } };
  try { assert.equal(chatgptInput.findSendControl(composer), null); }
  finally { global.document = old; }
});

test('Dex result without scoped Send or native form fails closed instead of synthetic Enter', () => {
  const fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../extension/content/chatgpt.js'), 'utf8');
  assert.match(source, /!sendControl && String\(delivery\?\.kind \|\| ''\)\.startsWith\('dex-'\)/);
  assert.match(source, /scoped Send button unavailable; preserving Dex draft instead of synthetic Enter/);
});
