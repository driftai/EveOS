const test = require('node:test');
const assert = require('node:assert/strict');
const chatgptAnswer = require('../extension/content/chatgpt-answer.js');

function node(attrs = {}, className = '', parentElement = null) {
  return {
    className,
    parentElement,
    getAttribute(name) { return attrs[name] ?? null; }
  };
}

function textNode(value) {
  return { nodeType: 3, nodeValue: String(value) };
}

function element(tagName, childNodes = []) {
  const nodeValue = {
    nodeType: 1,
    tagName,
    childNodes,
    parentElement: null,
    className: '',
    getAttribute() { return null; },
    matches() { return false; }
  };
  for (const child of childNodes) {
    if (child && child.nodeType === 1) child.parentElement = nodeValue;
  }
  Object.defineProperty(nodeValue, 'textContent', {
    get() {
      return childNodes.map((child) => child?.nodeType === 3 ? child.nodeValue : child?.textContent || '').join('');
    }
  });
  return nodeValue;
}

test('ChatGPT assistant ownership uses semantic author-role markers', () => {
  const turn = node({ 'data-message-author-role': 'assistant' });
  const content = node({}, 'markdown', turn);
  assert.equal(chatgptAnswer.isAssistantOwned(content), true);
  assert.equal(chatgptAnswer.isUserOwned(content), false);
});

test('ChatGPT user-owned content can never be emitted as assistant output', () => {
  const turn = node({ 'data-message-author-role': 'user' });
  const content = node({}, 'markdown', turn);
  assert.equal(chatgptAnswer.isUserOwned(content), true);
  assert.equal(chatgptAnswer.isAssistantOwned(content), false);
  assert.equal(chatgptAnswer.assistantText(content), '');
});

test('ChatGPT legacy assistant fallbacks remain recognized', () => {
  assert.equal(chatgptAnswer.hasAssistantMarker(node({ 'data-role': 'assistant' })), true);
  assert.equal(chatgptAnswer.hasAssistantMarker(node({ 'data-message-author': 'assistant' })), true);
  assert.equal(chatgptAnswer.hasAssistantMarker(node({}, 'agent-turn')), true);
});

test('ChatGPT nested-node pruning keeps only the outer response block', () => {
  const inner = {};
  const outer = { contains(candidate) { return candidate === inner; } };
  inner.contains = () => false;
  assert.deepEqual(chatgptAnswer.pruneNestedNodes([outer, inner]), [outer]);
});


test('ChatGPT list paragraphs stay attached to their bullets without phantom blank lines', () => {
  const root = element('UL', [
    element('LI', [element('P', [textNode('first item')])]),
    element('LI', [element('P', [textNode('second item')])])
  ]);
  assert.equal(chatgptAnswer.structuralText(root), '• first item\n• second item');
});

test('ChatGPT list wrapper divs do not push bullet text onto the next line', () => {
  const root = element('UL', [
    element('LI', [
      element('DIV', [
        element('DIV', [
          element('P', [textNode('Eve → Dex → Astro works')])
        ])
      ])
    ]),
    element('LI', [
      element('DIV', [
        element('P', [textNode('Astro → Dex → Eve works')])
      ])
    ])
  ]);
  assert.equal(
    chatgptAnswer.structuralText(root),
    '• Eve → Dex → Astro works\n• Astro → Dex → Eve works'
  );
});


test('prompt-bound response skips an older assistant turn', () => {
  const oldUser = node({ 'data-message-author-role': 'user' }); oldUser.innerText = 'old prompt';
  const oldAssistant = node({ 'data-message-author-role': 'assistant' }); oldAssistant.innerText = 'old answer';
  const newUser = node({ 'data-message-author-role': 'user' }); newUser.innerText = 'fresh proof prompt';
  const newAssistant = node({ 'data-message-author-role': 'assistant' }); newAssistant.innerText = 'fresh proof answer';
  const turns = [oldUser, oldAssistant, newUser, newAssistant];
  const root = { querySelectorAll(selector) {
    if (selector === chatgptAnswer.USER_SELECTOR) return [oldUser, newUser];
    if (selector.includes(chatgptAnswer.USER_SELECTOR) && selector.includes(chatgptAnswer.ASSISTANT_SELECTOR)) return turns;
    return [];
  } };
  assert.equal(chatgptAnswer.responseTextForUserPrompt('fresh proof prompt', 1, root), 'fresh proof answer');
  const laterAssistant = node({ 'data-message-author-role': 'assistant' });
  laterAssistant.innerText = 'fresh proof answer complete.';
  turns.push(laterAssistant);
  assert.equal(chatgptAnswer.responseTextForUserPrompt('fresh proof prompt', 1, root), 'fresh proof answer complete.');
  turns.pop();
  turns.pop();
  assert.equal(chatgptAnswer.responseTextForUserPrompt('fresh proof prompt', 1, root), '');
});

test('role-free ChatGPT DIL assistant replies are scoped to the selection message and remain readable', () => {
  const message = node({ 'data-chatgpt-selection-message-id': 'assistant-msg' }, 'group flex min-w-0 flex-col');
  const dilRoot = element('DIV', [
    element('P', [textNode('Ready. [[DEX:CMD {"action":"status","room":"room-eve-astro"}]]')])
  ]);
  dilRoot.className = 'DilRenderer-tB76Jj DilResponseRoot-HfQrEh';
  dilRoot.parentElement = message;
  message.querySelector = selector => selector === '[class*="DilResponseRoot"]' ? dilRoot : null;
  message.querySelectorAll = selector => selector === chatgptAnswer.CONTENT_SELECTOR ? [dilRoot] : [];
  const root = { querySelectorAll(selector) {
    return selector === chatgptAnswer.ASSISTANT_SELECTOR ? [message] : [];
  } };
  assert.match(chatgptAnswer.ASSISTANT_SELECTOR, /DilResponseRoot/);
  assert.equal(chatgptAnswer.hasDilAssistantMessage(message), true);
  const nodes = chatgptAnswer.assistantNodes(root);
  assert.deepEqual(nodes, [dilRoot]);
  assert.equal(chatgptAnswer.isAssistantOwned(dilRoot), true);
  assert.match(chatgptAnswer.getTurnAssistantText(nodes), /\[\[DEX:CMD \{"action":"status"/);
});

test('a selection id without a DIL response root never confers assistant ownership', () => {
  const user = node({ 'data-chatgpt-selection-message-id': 'user-msg' }, 'group flex');
  user.querySelector = () => null;
  const userContent = node({}, 'MarkdownRoot', user);
  assert.equal(chatgptAnswer.hasDilAssistantMessage(user), false);
  assert.equal(chatgptAnswer.isAssistantOwned(userContent), false);
  const explicitUser = node({ 'data-message-author-role': 'user', 'data-chatgpt-selection-message-id': 'user-dil' });
  explicitUser.querySelector = () => ({ className: 'DilResponseRoot-synthetic' });
  const quoted = node({}, 'TextBase', explicitUser);
  assert.equal(chatgptAnswer.isAssistantOwned(quoted), false, 'explicit user ownership always wins');
});
