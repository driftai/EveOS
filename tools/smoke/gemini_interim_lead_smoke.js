/**
 * gemini_interim_lead_smoke.js
 *
 * Live Gemini audio must stay near the live edge without cutting the source already being heard.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const HANDLER = path.join(ROOT, 'js', 'modules', 'gemini', 'agentic', 'audio_proc',
    'playback_proc', 'audio_injest_core', 'interimIngestHandler.js');
const fileUrl = (target) => 'file:///' + target.split(path.sep).join('/');

function assert(condition, message) {
    if (!condition) throw new Error('ASSERT FAILED: ' + message);
}

async function main() {
    const fixture = path.join(os.tmpdir(), `gem-lead-${process.pid}.html`);
    fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><body>
        <script>window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));</script>
        <script src="${fileUrl(HANDLER)}"></script>
    </body>`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.goto(fileUrl(fixture), { waitUntil: 'load' });
        const result = await page.evaluate(async () => {
            const H = window.AudioIngestCore && window.AudioIngestCore.InterimIngestHandler;
            const out = { ready: !!H };
            if (!H) return out;

            const CHUNK = 0.04;
            window.base64ToArrayBuffer = () => new ArrayBuffer(1920);
            window.createAudioBufferFromPCM = () => ({ duration: CHUNK });

            const started = [];
            let stoppedAudible = 0;
            let stoppedQueued = 0;
            const ctx = {
                currentTime: 0,
                createBuffer: () => ({ duration: 0 }),
                createBufferSource: () => {
                    const source = {
                        buffer: null,
                        playbackRate: { value: 1 },
                        connect() {}, disconnect() {},
                        start(at = 0) { source.startedAt = at; started.push(at); },
                        stop() {
                            if (Number(source.startedAt) <= ctx.currentTime + 0.01) stoppedAudible += 1;
                            else stoppedQueued += 1;
                        },
                        onended: null,
                        startedAt: Number.POSITIVE_INFINITY
                    };
                    return source;
                },
                createGain: () => ({ gain: { value: 1 }, connect() {} }),
                destination: {}
            };

            async function feed(count) {
                for (let i = 0; i < count; i += 1) await H.playInterimAudio('AAAA', ctx);
            }

            H.stopAll();
            stoppedAudible = 0;
            stoppedQueued = 0;
            await feed(140);
            out.leadAfterBacklog = +(H.nextStartTime - ctx.currentTime).toFixed(3);
            out.maxLead = typeof H.MAX_LEAD === 'number' ? H.MAX_LEAD : 2.0;
            out.capDeclared = typeof H.MAX_LEAD === 'number';
            out.backlogScheduled = started.length;
            out.stoppedAudibleDuringBacklog = stoppedAudible;
            out.stoppedQueuedDuringBacklog = stoppedQueued;
            out.diagnostics = H.getDiagnostics ? H.getDiagnostics() : null;

            // Snapshot before the explicit reset below: reset is allowed to stop current speech,
            // backlog recovery itself is not.
            H.stopAll('test-reset');
            ctx.currentTime = 0;
            started.length = 0;
            for (let i = 0; i < 40; i += 1) {
                await H.playInterimAudio('AAAA', ctx);
                ctx.currentTime += CHUNK;
            }
            out.leadWhenSteady = +(H.nextStartTime - ctx.currentTime).toFixed(3);
            out.steadyMonotonic = started.every((v, i) => i === 0 || v >= started[i - 1]);

            out.errors = window.__errors;
            return out;
        });

        assert(result.errors.length === 0, 'no page errors: ' + result.errors.join(' | '));
        assert(result.ready, 'the interim handler loaded');
        assert(result.backlogScheduled === 140,
            `all 140 chunks actually reached the scheduler (got ${result.backlogScheduled})`);
        assert(result.leadAfterBacklog <= result.maxLead + 0.2,
            `a long backlog stays bounded (lead ${result.leadAfterBacklog}s, cap ${result.maxLead}s)`);
        assert(result.maxLead < 5.6,
            `the cap is below the backlog it must catch (cap ${result.maxLead}s vs 5.6s of audio)`);
        assert(result.stoppedQueuedDuringBacklog > 0,
            'backlog recovery discarded not-yet-heard sources');
        assert(result.stoppedAudibleDuringBacklog === 0,
            'backlog recovery must never stop the source already being heard');
        assert(result.diagnostics?.backlogRecoveries > 0,
            'backlog recovery is observable through bounded diagnostics');
        assert(result.leadWhenSteady <= result.maxLead,
            `steady streaming stays under the cap (lead ${result.leadWhenSteady}s)`);
        assert(result.steadyMonotonic,
            'steady streaming schedules chunks in order, so normal playback is not chopped');

        console.log(`gemini interim lead OK — backlog lead ${result.leadAfterBacklog}s`
            + ` (cap ${result.maxLead}s), queued drops ${result.stoppedQueuedDuringBacklog}, steady lead ${result.leadWhenSteady}s`);
        console.log('GEMINI_INTERIM_LEAD_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
