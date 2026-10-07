'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createView } = require('../public/dex-room-view');

test('read-only room list remains navigable regardless of human editing mode', () => {
  const priorDocument = globalThis.document;
  try {
    globalThis.document = { createElement(tag) {
      return {
        tagName: tag, className: '', textContent: '', children: [], dataset: {},
        addEventListener(kind, handler) { this[kind] = handler; },
        append(...children) { this.children.push(...children); }
      };
    } };
    const list = { children: [], replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); } };
    const transcript = { children: [], scrollTop: 0, scrollHeight: 0, clientHeight: 100,
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
    const state = { activeRoomId: 'one', rooms: [
      { id: 'one', name: 'Eve and Astro', members: [{ id: 'eve' }], messages: [] },
      { id: 'two', name: 'Observer room', members: [], messages: [
        { senderKind: 'agent', senderName: 'Astro', text: 'Hello' }
      ] }
    ] };
    let selected = null;
    const view = createView({ state, el: { dexRoomList: list, dexTranscript: transcript },
      protocol: { messageWrapper: message => 'wrapped ' + message.text },
      onRoomSelect(room) { selected = room.id; } });
    view.renderRooms();
    assert.equal(list.children.length, 2);
    assert.match(list.children[0].className, /active/);
    list.children[1].click();
    assert.equal(selected, 'two');
    view.renderTranscript(state.rooms[1]);
    assert.equal(transcript.children.length, 1);
    assert.equal(transcript.children[0].children[1].textContent, 'wrapped Hello');
  } finally { globalThis.document = priorDocument; }
});
