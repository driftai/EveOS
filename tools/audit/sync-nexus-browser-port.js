#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY = path.join(ROOT, 'config', 'eveos-ports.json');
const TARGET = path.join(ROOT, 'tools', 'Nexus-Browser', 'extension', 'runtime-config.js');

function expectedSource() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const port = Number(registry?.ports?.NEXUS_BROWSER_PORT?.port);
  const controlPort = Number(registry?.ports?.GEMINI_CONTROL_PORT?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('NEXUS_BROWSER_PORT is invalid in config/eveos-ports.json.');
  }
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error('GEMINI_CONTROL_PORT is invalid in config/eveos-ports.json.');
  }
  return `/* Generated from config/eveos-ports.json by tools/audit/sync-nexus-browser-port.js. */
(() => {
  const port = ${port};
  const controlPort = ${controlPort};
  const httpOrigin = \`http://127.0.0.1:\${port}\`;
  const config = Object.freeze({
    port,
    httpOrigin,
    controlOrigin: \`http://127.0.0.1:\${controlPort}\`,
    healthUrl: \`\${httpOrigin}/health\`,
    websocketUrl: \`ws://127.0.0.1:\${port}/ws\`,
    dexUrl: \`\${httpOrigin}/?mode=dex\`,
    tabPattern: \`\${httpOrigin}/*\`
  });
  globalThis.NexusBrowserRuntimeConfig = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})();
`;
}

function main() {
  const expected = expectedSource();
  const actual = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : '';
  if (actual === expected) {
    console.log('NEXUS_BROWSER_PORT_CONFIG_OK');
    return;
  }
  if (!process.argv.includes('--write')) {
    console.error('NEXUS_BROWSER_PORT_CONFIG_DRIFT');
    process.exit(1);
  }
  fs.writeFileSync(TARGET, expected, 'utf8');
  console.log('NEXUS_BROWSER_PORT_CONFIG_SYNCED');
}

main();
