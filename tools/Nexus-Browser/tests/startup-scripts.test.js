const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const START_BAT = path.join(ROOT, 'START.bat');
const VERIFY_BAT = path.join(ROOT, 'VERIFY.bat');
const BOOTSTRAP_BAT = path.join(ROOT, 'scripts', 'bootstrap.bat');
const SUPERVISOR = path.join(ROOT, 'scripts', 'bridge-supervisor.js');

const SCRIPTS = [
  { name: 'START.bat', path: START_BAT },
  { name: 'VERIFY.bat', path: VERIFY_BAT },
  { name: 'scripts/bootstrap.bat', path: BOOTSTRAP_BAT }
];

const PROHIBITED_TOKENS = [
  'powershell',
  'pwsh',
  'SendKeys',
  'AppActivate',
  'SetForegroundWindow',
  'taskkill',
  'explorer.exe',
  'start http',
  'start chrome'
];

function physicalLines(content) {
  if (!content) return 0;
  return content.split(/\r\n|\n|\r/).length;
}

test('startup and verification scripts exist with valid line counts', () => {
  for (const { name, path: scriptPath } of SCRIPTS) {
    assert.equal(fs.existsSync(scriptPath), true, `${name} should exist`);
    const content = fs.readFileSync(scriptPath, 'utf8');
    const lines = physicalLines(content);
    assert.ok(lines > 0, `${name} should not be empty`);
    assert.ok(lines <= 450, `${name} has ${lines} lines, exceeding 450 hard cap`);
  }
});

test('startup and verification scripts contain no prohibited side-effect commands', () => {
  for (const { name, path: scriptPath } of SCRIPTS) {
    const content = fs.readFileSync(scriptPath, 'utf8');
    const lowerContent = content.toLowerCase();
    for (const token of PROHIBITED_TOKENS) {
      assert.equal(
        lowerContent.includes(token.toLowerCase()),
        false,
        `${name} contains prohibited command or side-effect token: "${token}"`
      );
    }
  }
});

test('START.bat delegates to bootstrap and executes supervisor or server entry', () => {
  const content = fs.readFileSync(START_BAT, 'utf8');
  assert.match(content, /scripts\\bootstrap\.bat|scripts\/bootstrap\.bat/, 'START.bat must delegate to bootstrap');
  assert.match(content, /node (?:scripts\\bridge-supervisor\.js|server\.js)/, 'START.bat must run bridge-supervisor or server.js');
  assert.match(content, /pause/, 'START.bat must pause on errorlevel 1');
});

test('bridge supervisor exits when another healthy Nexus runtime already owns the port', () => {
  const content = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.match(content, /existing bridge server is already healthy; extra supervisor exiting/);
  assert.match(content, /process\.exit\(0\)/);
});

test('bridge supervisor self-registers one owned supervisor PID and releases it on exit', () => {
  const content = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.match(content, /supervisor\.pid/);
  assert.match(content, /fs\.openSync\(PID_FILE, 'wx'\)/);
  assert.match(content, /another Nexus supervisor PID/);
  assert.match(content, /process\.on\('exit', releaseSupervisor\)/);
});

test('VERIFY.bat delegates to bootstrap and executes npm test', () => {
  const content = fs.readFileSync(VERIFY_BAT, 'utf8');
  assert.match(content, /scripts\\bootstrap\.bat|scripts\/bootstrap\.bat/, 'VERIFY.bat must delegate to bootstrap');
  assert.match(content, /npm test/, 'VERIFY.bat must run npm test');
  assert.match(content, /FAILED/, 'VERIFY.bat must report failure status');
  assert.match(content, /PASSED/, 'VERIFY.bat must report pass status');
  assert.match(content, /pause/, 'VERIFY.bat must pause on failure');
});

test('scripts/bootstrap.bat performs required environment validation', () => {
  const content = fs.readFileSync(BOOTSTRAP_BAT, 'utf8');
  assert.match(content, /where node/, 'bootstrap.bat must verify node availability');
  assert.match(content, /where npm/, 'bootstrap.bat must verify npm availability');
  assert.match(content, /18/, 'bootstrap.bat must validate Node version >= 18');
  assert.match(content, /npm ci/, 'bootstrap.bat must support npm ci with package-lock.json');
  assert.match(content, /npm install/, 'bootstrap.bat must support npm install fallback');
  assert.match(content, /cd \/d "%~dp0\.\."/, 'bootstrap.bat must safely anchor to project root');
  assert.match(content, /exit \/b 1/, 'bootstrap.bat must propagate nonzero exit code on failure');
});

test('bootstrap.bat executes cleanly in current Windows environment', () => {
  if (process.platform !== 'win32') return;

  const result = spawnSync('cmd.exe', ['/c', BOOTSTRAP_BAT], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `bootstrap.bat exited with non-zero code ${result.status}:\n${result.stderr || result.stdout}`);
});
