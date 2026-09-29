'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const expect = (condition, message) => {
    if (!condition) throw new Error(message);
};

const overlay = read('js', 'modules', 'features', 'world-book', 'world-book.overlay.js');
const gemini = read('js', 'modules', 'features', 'world-book', 'world-book.narration.gemini.js');
const readBlock = overlay.slice(
    overlay.indexOf('async function readNotesAloud'),
    overlay.indexOf('function renderDetachState')
);
expect(readBlock.includes('primeAudio') && readBlock.indexOf('primeAudio') < readBlock.indexOf('await '),
    'Notes narration does not prime WebAudio before its first await');
expect(!readBlock.includes('ns.client.start') && !readBlock.includes('ensureNarrationTarget'),
    'Notes narration still starts or requires the World Book server');
expect(readBlock.includes('local: true'),
    'Notes narration is not routed through the EveOS-owned local runtime');
expect(gemini.includes("const WS_URL = 'ws://127.0.0.1:9085'")
    && gemini.includes("sessionRole: 'world_book_narration'"),
    'local Notes narration is not using the canonical isolated Gemini lane');
expect(gemini.includes("if (pendingTurn) throw new Error"),
    'local narration can create overlapping Gemini turns on one session');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function main() {
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><body></body></html>');
    });
    const port = await listen(server);
    const launched = await launchChromiumOrConnect({ headless: true });
    const context = await launched.browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(`http://127.0.0.1:${port}/`);
        for (const file of [
            'world-book.narration.audio.js',
            'world-book.narration.cache.js',
            'world-book.narration.gemini.js',
            'world-book.narration.runtime.js',
        ]) {
            await page.addScriptTag({ path: path.join(ROOT, 'js', 'modules', 'features', 'world-book', file) });
        }

        const result = await page.evaluate(async () => {
            const audio = window.EveWorldBookNarrationAudio;
            let resumeCalls = 0;
            let starts = 0;
            class FakeAudioContext {
                constructor() {
                    this.state = 'suspended';
                    this.currentTime = 0;
                    this.destination = {};
                }
                resume() {
                    resumeCalls += 1;
                    this.state = 'running';
                    return Promise.resolve();
                }
                suspend() { this.state = 'suspended'; return Promise.resolve(); }
                close() { this.state = 'closed'; return Promise.resolve(); }
                createGain() {
                    return { gain: { value: 1 }, connect() { return this; } };
                }
                createBuffer(_channels, frames, sampleRate) {
                    return {
                        duration: frames / sampleRate,
                        getChannelData() { return new Float32Array(frames); }
                    };
                }
                createBufferSource() {
                    const source = {
                        connect() { return source; },
                        start() { starts += 1; },
                        stop() {},
                        onended: null
                    };
                    return source;
                }
            }
            window.AudioContext = FakeAudioContext;
            const primePromise = audio.prime();
            const resumeCallsBeforeAwait = resumeCalls;
            const primed = await primePromise;

            const first = new Int16Array([0, 0, 2200, -2200, 1200, 0]).buffer;
            const second = new Int16Array([0, 1700, -1700, 900, 0, 0]).buffer;
            const stream = audio.beginStream({ volume: 0.5 });
            stream.push(first, 24000);
            const startsAfterFirst = starts;
            stream.push(second, 24000);
            const startsAfterSecond = starts;
            const streamResult = stream.finish();

            await audio.close();
            let blockedResumeCalls = 0;
            class BlockedAudioContext extends FakeAudioContext {
                resume() {
                    blockedResumeCalls += 1;
                    return Promise.resolve();
                }
            }
            window.AudioContext = BlockedAudioContext;
            const blocked = await audio.prime();

            localStorage.setItem('eveWorldBookNarrationSettings', JSON.stringify({ engine: 'gemini' }));
            const runtime = window.EveWorldBookNarrationRuntime;
            runtime.load({
                id: 'eveos:scratchpad',
                title: 'EveOS Scratchpad',
                text: 'Helllooo Test 123',
                kind: 'scratchpad',
                locator: 'EveOS / Notes / Scratchpad'
            });
            const blockedPrime = runtime.primeAudio();
            runtime.play({ primePromise: blockedPrime });
            await new Promise(resolve => setTimeout(resolve, 30));
            const blockedState = runtime.getState();

            const trimmed = audio.trimPcm(new Int16Array([0, 0, 0, 1500, -1500, 0, 0, 0]).buffer);
            return {
                resumeCallsBeforeAwait,
                primed,
                startsAfterFirst,
                startsAfterSecond,
                streamResult,
                blockedResumeCalls,
                blocked,
                blockedState,
                trimmedBytes: trimmed.byteLength
            };
        });

        expect(result.resumeCallsBeforeAwait === 1,
            'AudioContext.resume was deferred past the direct user-activation call stack');
        expect(result.primed.ok === true && result.primed.state === 'running',
            `priming did not establish a running context: ${JSON.stringify(result.primed)}`);
        expect(result.startsAfterFirst === 0 && result.startsAfterSecond >= 1 && result.streamResult.started,
            `PCM chunks were not scheduled sequentially as they arrived: ${JSON.stringify(result)}`);
        expect(result.blockedResumeCalls === 1 && result.blocked.ok === false,
            'a suspended AudioContext was reported as playable');
        expect(result.blockedState.status === 'blocked' && /Tap Play/i.test(result.blockedState.error || ''),
            `blocked playback produced a false playing state: ${JSON.stringify(result.blockedState)}`);
        expect(result.trimmedBytes > 0 && result.trimmedBytes < 16,
            `leading/trailing digital silence was not trimmed: ${result.trimmedBytes}`);
        console.log('WORLD_BOOK_NOTES_NARRATION_BROWSER_SMOKE_OK');
    } finally {
        await context.close();
        if (launched.mode === 'launch') await launched.browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
