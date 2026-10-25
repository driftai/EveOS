'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

test('server startup graph resolves in an isolated non-listening process', { timeout: 15_000 }, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-startup-isolation-'));
  const dataDir = path.join(sandbox, 'runtime');
  const profileDir = path.join(sandbox, 'profile');
  const tempDir = path.join(sandbox, 'temp');
  const appDataDir = path.join(sandbox, 'appdata');
  const localAppDataDir = path.join(sandbox, 'localappdata');
  for (const folder of [dataDir, profileDir, tempDir, appDataDir, localAppDataDir]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  const script = [
    "const net=require('node:net');",
    "net.Server.prototype.listen=function(){throw new Error('ISOLATED_IMPORT_LISTEN_ATTEMPT')};",
    `const loaded=require(${JSON.stringify(SERVER)});`,
    "if(!loaded?.server||!loaded?.wss)throw new Error('SERVER_EXPORTS_MISSING');",
    "if(loaded.PORT!==49199)throw new Error('ISOLATED_PORT_MISMATCH');",
    "if(loaded.wss.options?.noServer!==true)throw new Error('WEBSOCKET_ISOLATION_MISSING');",
    "if(loaded.server.listening)throw new Error('ISOLATED_IMPORT_OPENED_PORT');",
    "process.stdout.write('NEXUS_SERVER_STARTUP_IMPORT_OK\\n');",
    'process.exit(0);'
  ].join('');
  const env = {
    NEXUS_BROWSER_DATA_DIR: dataDir,
    NEXUS_BROWSER_PORT: '49199',
    PORT: '49199',
    HOST: '127.0.0.1',
    HOME: profileDir,
    USERPROFILE: profileDir,
    APPDATA: appDataDir,
    LOCALAPPDATA: localAppDataDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
  };
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env,
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    const diagnostics = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.error, undefined, `${result.error?.stack || result.error?.message}\n${diagnostics}`);
    assert.equal(result.status, 0, diagnostics);
    assert.match(result.stdout, /NEXUS_SERVER_STARTUP_IMPORT_OK/);
    assert.doesNotMatch(diagnostics, /Nexus Browser\] UI|EADDRINUSE|ISOLATED_IMPORT_LISTEN_ATTEMPT/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
