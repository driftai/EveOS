import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

const port = 21000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true
});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready. ${stderr.trim()}`);
}

try {
  const root = await waitForServer();
  const policy = root.headers.get('content-security-policy') || '';
  const html = await root.text();
  assert.match(policy, /script-src 'self'/, 'CSP must restrict executable scripts');
  assert.match(policy, /script-src[^;]*\bblob:/, 'CSP must allow ONNX Runtime worker module blobs');
  assert.doesNotMatch(policy, /'unsafe-inline'/, 'CSP must not allow arbitrary inline script');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i, 'HTML must not depend on inline scripts or import maps');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'HTML must not depend on inline event handlers');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'HTML must not depend on inline styles');
  const bareSpecifiers = [
    /\bfrom\s*['"](?!(?:\.{1,2}\/|\/|https?:\/\/|data:|blob:))([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](?!(?:\.{1,2}\/|\/|https?:\/\/|data:|blob:))([^'"]+)['"]/g,
    /^\s*import\s*['"](?!(?:\.{1,2}\/|\/|https?:\/\/|data:|blob:))([^'"]+)['"]/gm
  ];
  for (const file of listJavaScriptFiles(publicDir)) {
    const source = readFileSync(file, 'utf8');
    const imports = bareSpecifiers.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]));
    assert.deepEqual(imports, [], `${file.slice(dirname(publicDir).length + 1)} must use browser-resolvable module paths`);
  }
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(root.headers.get('access-control-allow-origin'), null, 'local responses must not opt into cross-origin reads');

  const status = await fetch(`${baseUrl}/api/status`, { headers: { Origin: baseUrl } });
  assert.equal(status.status, 200, 'same-origin local API request should succeed');
  const payload = await status.json();
  assert.equal('media' in payload, false, 'status must not expose local media filenames');
  assert.equal('mediaCount' in payload, false, 'status must not expose local media inventory');

  const crossOrigin = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: 'https://untrusted.example' }
  });
  assert.equal(crossOrigin.status, 403, 'cross-origin local API request must be rejected');

  const publicDemo = await fetch(`${baseUrl}/media/voxelvision-demo.depth.json`);
  assert.equal(publicDemo.status, 200, 'public procedural demo must be present');
  const metadata = await publicDemo.json();
  const depthResponse = await fetch(`${baseUrl}/media/${metadata.data}`);
  assert.equal(depthResponse.status, 200, 'public procedural depth payload must be present');
  const depthBytes = gunzipSync(Buffer.from(await depthResponse.arrayBuffer()));
  assert.equal(
    depthBytes.length,
    metadata.frameCount * metadata.grid.cols * metadata.grid.rows,
    'public procedural depth payload must match its declared grid and frame count'
  );
  const removedDemo = await fetch(`${baseUrl}/media/take-on-me.depth.json`);
  assert.equal(removedDemo.status, 404, 'private development demo must not be distributed');

  console.log('Public-release privacy and local-server security smoke passed.');
} finally {
  child.kill();
}
