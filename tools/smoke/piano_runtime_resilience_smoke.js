const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const clientPath = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.piano.client.js');
const uiPath = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.piano.ui.js');
const appPath = path.join(ROOT, 'tools', 'Piano-Auto-Player', 'web', 'app.js');
const progressPath = path.join(ROOT, 'tools', 'Piano-Auto-Player', 'web', 'sheet_progress.js');
const serverPath = path.join(ROOT, 'tools', 'Piano-Auto-Player', 'app', 'server.py');
const launcherPath = path.join(ROOT, 'tools', 'Piano-Auto-Player', 'start.bat');
const resumePath = path.join(ROOT, 'js', 'modules', 'core', 'eveos-resume.js');
const audioUiPath = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.js');

async function main() {
  const client = fs.readFileSync(clientPath, 'utf8');
  const ui = fs.readFileSync(uiPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const progress = fs.readFileSync(progressPath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  const resume = fs.readFileSync(resumePath, 'utf8');
  const audioUi = fs.readFileSync(audioUiPath, 'utf8');
  assert(client.includes('TRANSIENT_OUTAGE_GRACE_MS') && client.includes("phase: 'reconnecting'"), 'host client must preserve a running Piano frame across a transient outage');
  assert(!ui.includes("{ once: true }"), 'host context bridge must survive legitimate iframe reloads');
  assert(app.includes('statusPollDelay()'), 'Piano status polling must use the adaptive cadence');
  assert(!progress.includes('fetch("/api/status"'), 'Sheet Progress must consume the shared status event instead of polling independently');
  assert(server.includes('urlparse(self.path).path == "/api/status"'), 'successful status heartbeats must be excluded from routine server logging');
  assert(server.includes('except (ConnectionError, OSError):'), 'aborted static-file clients must not emit server tracebacks');
  assert(!resume.includes("addEventListener('focus'"), 'ordinary native-window focus must not masquerade as a lifecycle resume');
  assert(!/resume:\s*\(\)\s*=>[^\n]*rerender\(\)/.test(audioUi), 'Audioflix resume must preserve mounted tool frames');
  assert(audioUi.includes('if (!refreshMountedTool()) rerender();'), 'late Audioflix loading must preserve an already-mounted Piano workspace');
  assert((audioUi.match(/if \(!refreshMountedTool\(\)\) rerender\(\);/g) || []).length >= 2, 'Audioflix state refreshes must preserve mounted tool workspaces');
  assert(!launcher.includes('start "" "http://127.0.0.1:8771"'), 'localhost boot must not open a standalone Piano browser');
  assert(!launcher.includes('-OpenBrowser'), 'shared Piano boot must leave opening/detaching under explicit user control');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: resume });
    const resumeSignals = await page.evaluate(async () => {
      const reasons = [];
      window.addEventListener('eve:app-resume', event => reasons.push(event.detail?.reason));
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolve => setTimeout(resolve, 220));
      const focusCount = reasons.length;
      window.dispatchEvent(new Event('online'));
      await new Promise(resolve => setTimeout(resolve, 220));
      return { focusCount, reasons };
    });
    assert(resumeSignals.focusCount === 0, 'window focus alone must not trigger application recovery');
    assert(resumeSignals.reasons.includes('online'), 'real connectivity recovery must still signal resume');
    await page.evaluate(() => {
      window.config = { bridges: { pianoPlayerPort: 8771, localControlPort: 9082 } };
      window.EveOSLocalControl = { baseUrl: () => 'http://127.0.0.1:9082' };
      window.__pianoOnline = true;
      window.fetch = async (url) => {
        if (!window.__pianoOnline) throw new TypeError('synthetic disconnect');
        if (String(url).includes('/api/piano-player/status')) return new Response(JSON.stringify({
          running: true, state: 'running', url: 'http://127.0.0.1:8771/', localUrl: 'http://127.0.0.1:8771/', appVersion: 'test'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (String(url).includes(':8771/api/status')) return new Response(JSON.stringify({
          ok: true, service: 'piano-auto-player', appVersion: 'test'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        throw new TypeError('synthetic unavailable endpoint');
      };
    });
    await page.addScriptTag({ content: client });
    const online = await page.evaluate(() => window.EveAudioflixPiano.refresh());
    assert(online.running === true && online.phase === 'running', 'online fixture must establish the running baseline');
    const transient = await page.evaluate(async () => {
      window.__pianoOnline = false;
      return window.EveAudioflixPiano.refresh();
    });
    assert(transient.running === true && transient.phase === 'reconnecting', 'one connection miss must keep the existing workspace alive');
    const expired = await page.evaluate(async () => {
      const realNow = Date.now;
      const future = realNow() + 13_000;
      Date.now = () => future;
      try { return await window.EveAudioflixPiano.refresh(); } finally { Date.now = realNow; }
    });
    assert(expired.running === false && expired.phase === 'unavailable', 'a sustained outage must still converge to stopped');
  } finally {
    await browser.close();
  }
  console.log('PIANO_RUNTIME_RESILIENCE_SMOKE_OK tests=17');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch(error => {
  console.error(`PIANO_RUNTIME_RESILIENCE_SMOKE_FAIL ${error.message}`);
  process.exitCode = 1;
});
