'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-spotify-reload-'));
// Real HTTP broker and relay, isolated fake provider: no user's library, profile or audio changes.
const python = String.raw`
import http.server, json, os, pathlib, sys, time
from tools.smoke import audioflix_spotify_broker_smoke as fixture
from server_modules import audioflix_spotify_http as api
fixture.mod._broker = fixture.mod.SpotifyClientBroker()
delay = [0]
transport = fixture.fake.transport
def delayed_transport(payload=None):
    if (payload or {}).get('action') == 'load': time.sleep(delay[0])
    return transport(payload)
fixture.mod.engine.transport = delayed_transport
root = pathlib.Path(os.environ['EVEOS_RELOAD_FIXTURE_ROOT'])
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        from urllib.parse import urlsplit, parse_qs
        parsed = urlsplit(self.path)
        if api.handle_get_request(self, parsed.path, parse_qs(parsed.query)): return
        if parsed.path == '/test/state':
            body = json.dumps({'engine': fixture.fake.state, 'owner': fixture.mod._broker._owner_client_id}).encode()
        elif parsed.path == '/test/delay':
            delay[0] = 1.2; body = b'{}'
        elif parsed.path == '/EveOS.html': body = (root / 'EveOS.html').read_bytes()
        else: self.send_error(404); return
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not api.handle_post_request(self, self.path): self.send_error(404)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print('RELOAD_FIXTURE_PORT=' + str(server.server_port), flush=True)
server.serve_forever()
`;

async function until(check, message, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
}

async function run() {
    const child = spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-u', '-c', python], {
        cwd: ROOT, env: { ...process.env, EVEOS_RELOAD_FIXTURE_ROOT: fixtureRoot }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '', diagnostics = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-16000); });
    let browser;
    const pages = [];
    try {
        await until(() => /RELOAD_FIXTURE_PORT=(\d+)/.test(output), `fixture startup failed: ${diagnostics}`);
        const base = `http://127.0.0.1:${output.match(/RELOAD_FIXTURE_PORT=(\d+)/)[1]}`;
        const remote = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.remote.js'), 'utf8');
        const html = `<!doctype html><meta charset="utf-8"><button id="play">Play Spotify</button><pre id="result"></pre>
<script>window.EveAudioflixState={ensure:()=>({nativeBridgeBase:${JSON.stringify(base)},libraryScopeId:'reload-fixture'})};</script>
<script>${remote}</script><script>
document.querySelector('#play').onclick=async()=>{
 const result=await EveAudioflixSpotifyRemote.send('play',{spotifyId:'4cOdK2wGLETKBW3PvgPWqT',duration:180});
 document.querySelector('#result').textContent=JSON.stringify(result);
};</script>`;
        fs.writeFileSync(path.join(fixtureRoot, 'EveOS.html'), html);
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const state = async () => (await fetch(`${base}/test/state`)).json();
        const makePage = async url => {
            const page = await context.newPage(); pages.push(page);
            await page.goto(url);
            await page.evaluate(() => EveAudioflixSpotifyRemote.connect());
            if (await page.evaluate(() => EveAudioflixSpotifyRemote.snapshot().approvalRequired)) {
                const approval = await context.newPage();
                await approval.goto(await page.evaluate(() => EveAudioflixSpotifyRemote.snapshot().approvalUrl));
                await approval.locator('#approve').click();
                await page.evaluate(() => EveAudioflixSpotifyRemote.waitUntilReady(5000));
                if (!approval.isClosed()) await approval.close();
            }
            return page;
        };
        const play = async page => {
            await page.locator('#play').click();
            await until(async () => (await state()).engine.status === 'playing', 'fixture did not play');
            await page.waitForFunction(() => document.querySelector('#result').textContent.includes('"ok":true'));
        };
        const stopped = async () => {
            await until(async () => {
                const value = await state();
                return value.engine.status === 'stopped' && value.engine.currentTime === 0 && !value.owner;
            }, 'refresh/close did not stop/reset owner');
        };
        const localhost = await makePage(`${base}/EveOS.html`);
        await play(localhost);
        await localhost.reload();
        await stopped();

        const file = await makePage(pathToFileURL(path.join(fixtureRoot, 'EveOS.html')).href);
        await play(file);
        await file.reload();
        await stopped();
        const reconnected = await file.evaluate(() => EveAudioflixSpotifyRemote.connect());
        assert.equal(reconnected.connected, true, 'file reload preserves approval');
        await play(file); // new sequence must exceed the reused file client's old high-water mark

        const observer = await makePage(`${base}/EveOS.html`);
        await observer.reload();
        await observer.evaluate(() => EveAudioflixSpotifyRemote.connect());
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal((await state()).engine.status, 'playing', 'observer refresh must not stop owner');
        await file.close();
        await stopped();

        // Refresh while Play is still awaiting the provider. Relay unload must not wait for its reply.
        await fetch(`${base}/test/delay`);
        await observer.locator('#play').click();
        await until(async () => (await state()).owner, 'slow Play did not acquire ownership');
        await observer.reload();
        await stopped();
        await new Promise(resolve => setTimeout(resolve, 350));
        assert.equal((await state()).engine.status, 'stopped', 'late Play must not resurrect playback');
        console.log('AUDIOFLIX_SPOTIFY_RELOAD_BROWSER_SMOKE_OK (localhost/file reload, replay, observer, close, pending Play)');
    } catch (error) {
        const evidence = path.join(ROOT, 'data/runtime/smoke-results', `spotify-reload-${Date.now()}`);
        fs.mkdirSync(evidence, { recursive: true });
        fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: error.stack, diagnostics }, null, 2));
        for (const [index, page] of pages.entries()) {
            if (!page.isClosed()) await page.screenshot({ path: path.join(evidence, `page-${index}.png`) }).catch(() => {});
        }
        console.error(`Reload evidence: ${evidence}`);
        throw error;
    } finally {
        await browser?.close();
        child.kill();
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
