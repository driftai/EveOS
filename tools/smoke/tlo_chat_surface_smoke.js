#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const modulePath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'tloChat.js');
const manifestPath = path.join(ROOT, 'js', 'config', 'manifest', 'scripts.parts', '13-gemini.js');
const cssPath = path.join(ROOT, 'css', 'modules', 'gemini', 'gemini_link_surfaces.tlo-chat.css');
const source = fs.readFileSync(modulePath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const windowMock = {
    setTimeout, clearTimeout, crypto: globalThis.crypto,
    location: { protocol: 'http:', origin: 'http://127.0.0.1:8765' }
};

vm.runInNewContext(source, {
    window: windowMock, console, setTimeout, clearTimeout, AbortController,
    TextDecoder, Uint32Array, Date, fetch: async () => { throw new Error('unexpected fetch'); }
}, { filename: modulePath });

function requireContract(condition, message) {
    if (!condition) throw new Error(message);
}

async function assertSendRaces() {
    const waiting = [];
    let streams = 0;
    const mock = { ...windowMock };
    delete mock.EveOSTloChat;
    vm.runInNewContext(source, {
        window: mock, console, AbortController, TextDecoder, Uint32Array, Date,
        fetch: async (url) => {
            if (url.includes('/status')) return new Promise(resolve => waiting.push(resolve));
            if (url.includes('/cancel')) return { ok: true };
            streams += 1;
            return { ok: true, body: new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n'));
                controller.close();
            } }) };
        }
    });
    const api = mock.EveOSTloChat;
    api.bind({ addEventListener() {}, querySelector(selector) {
        return selector === '[data-tlo-form]' ? { querySelector() { return null; } } : null;
    } });
    const first = api.sendWorkspaceMessage('first');
    const second = api.sendWorkspaceMessage('second');
    const results = Promise.allSettled([first, second]);
    requireContract(waiting.length === 2, 'Fixture did not overlap readiness probes');
    waiting.forEach(resolve => resolve({ ok: true, json: async () => ({ ok: true, canChat: true }) }));
    const settled = await results;
    requireContract(streams === 1, `Concurrent readiness produced ${streams} generations`);
    requireContract(settled[0].status === 'fulfilled' && settled[1].reason?.code === 'TLO_WORKSPACE_BUSY', 'Duplicate admission was not rejected');
    let partials = 0;
    const canceled = await api.sendWorkspaceMessage('cancel', { onPartial() { partials += 1; api.cancel(); } })
        .then(() => null, error => error);
    requireContract(partials === 1, 'Canceled stream emitted late partials');
    requireContract(canceled?.code === 'TLO_WORKSPACE_INTERRUPTED', 'Canceled stream reported success');
    requireContract(!api.workspaceSnapshot().busy, 'Cancellation retained an active request');
}

async function assertWorkspaceContextIsolation() {
    const requests = [];
    const mock = { ...windowMock };
    delete mock.EveOSTloChat;
    vm.runInNewContext(source, {
        window: mock, console, AbortController, TextDecoder, Uint32Array, Date,
        fetch: async (url, options = {}) => {
            if (url.includes('/status')) return { ok: true, json: async () => ({ ok: true, canChat: true }) };
            requests.push(JSON.parse(options.body));
            return { ok: true, body: new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'));
                controller.close();
            } }) };
        }
    });
    const api = mock.EveOSTloChat;
    api.bind({ addEventListener() {}, querySelector(selector) {
        return selector === '[data-tlo-form]' ? { querySelector() { return null; } } : null;
    } });
    await api.sendWorkspaceMessage('[DEX ROOM RELAY]\nRoom ID: room-one\nCurrent message: first');
    await api.sendWorkspaceMessage('[DEX ROOM RELAY]\nRoom ID: room-two\nCurrent message: second');
    requireContract(requests.length === 2 && requests.every((request) => request.history.length === 0),
        'Dex workspace envelopes leaked into shared TLO inference history');
    requireContract(api.workspaceSnapshot().historyMessages === 0,
        'Dex workspace envelopes polluted the standalone Search Monitor conversation');
}

async function run() {
    const api = windowMock.EveOSTloChat;
    const markup = api?.markup?.() || '';
    for (const contract of ['data-agent-id="tlo"', 'data-tlo-transcript', 'data-tlo-form',
        'data-tlo-action="cancel"', 'data-tlo-action="clear"', 'data-agent-nexus-view="management"']) {
        requireContract(markup.includes(contract), `TLO chat surface is missing ${contract}`);
    }
    requireContract(source.includes('/api/eve-state/modular/tlo/chat/stream')
        && source.includes('/api/eve-state/modular/tlo/chat/cancel'),
        'TLO chat is not connected to the EveOS streaming/cancel adapter');
    requireContract(!source.includes('/api/local-moe/start'), 'Opening TLO can start Local MoE');
    requireContract(source.includes("api_unreachable") && source.includes('retry automatically'),
        'TLO status no longer distinguishes a reachable EveOS server from an unreachable TLO API');
    requireContract(manifest.indexOf('tloChat.js') < manifest.indexOf('agentNexus.js'),
        'TLO chat is not loaded before the Agent Nexus facade');
    requireContract(/@media \(max-width: 620px\)/.test(css), 'TLO chat lacks its narrow-layout contract');

    const encoder = new TextEncoder();
    const chunks = [
        'data: {"choices":[{"delta":{"content":"A"}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DO',
        'NE]\n\n'
    ];
    const body = new ReadableStream({
        start(controller) {
            chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
            controller.close();
        }
    });
    let text = '';
    let finalized = 0;
    await api.consumeSseResponse({ body }, {
        onDelta(piece) { text += piece; },
        onDone() { finalized += 1; }
    });
    requireContract(text === 'AB', `Streaming deltas were not ordered: ${text}`);
    requireContract(finalized === 1, `Streaming finalized ${finalized} times`);
    await assertSendRaces();
    await assertWorkspaceContextIsolation();
    console.log('TLO_CHAT_SURFACE_SMOKE_OK');
}

run().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
});
