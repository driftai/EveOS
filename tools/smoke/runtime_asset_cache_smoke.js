#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PYTHON_SOURCE = String.raw`
import functools
import http.client
import http.server
import io
import json
import pathlib
import socket
import tempfile
import threading

from server_modules.eveos_http_headers import EveOSHTTPHeadersMixin

checks = 0


def check(condition, test_id):
    global checks
    assert condition, test_id
    checks += 1


class Handler(EveOSHTTPHeadersMixin, http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if not self.path.startswith('/api/'):
            return super().do_GET()
        if self.path == '/api/send-error':
            return self.send_error(500, 'fixture error')
        failed = self.path == '/api/failure'
        self.send_response(500 if failed else 200)
        self.send_header('Content-Type', 'application/json')
        if self.path == '/api/prepopulated':
            self.send_header('Access-Control-Allow-Origin', 'https://prepopulated.example')
        self.end_headers()
        self.wfile.write(b'{"error":true}' if failed else b'{"ok":true}')

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


def raw_response(address, method, target, origin=None):
    # Require EOF from the server itself; HTTPConnection can hide missing closes.
    lines = [f'{method} {target} HTTP/1.1', 'Host: localhost', 'Connection: keep-alive']
    if origin is not None:
        lines.append(f'Origin: {origin}')
    with socket.create_connection(address, timeout=2) as client:
        client.settimeout(2)
        client.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('ascii'))
        chunks = []
        while True:
            try:
                chunk = client.recv(4096)
            except socket.timeout as exc:
                raise AssertionError(f'{method} {target}: server did not close at EOF') from exc
            if not chunk:
                break
            chunks.append(chunk)
            if sum(map(len, chunks)) >= 65536:
                raise AssertionError('api-response-bounded')
    header_bytes, body = b''.join(chunks).split(b'\r\n\r\n', 1)
    status_line, header_bytes = header_bytes.split(b'\r\n', 1)
    headers = http.client.parse_headers(io.BytesIO(header_bytes + b'\r\n\r\n'))
    check(status_line.startswith(b'HTTP/1.1 '), f'{method} {target}: http11')
    check(headers.get('Connection', '').lower() == 'close', f'{method} {target}: close-header')
    check(headers.get('Cache-Control') == 'no-store, no-cache, must-revalidate',
          f'{method} {target}: private-cache')
    check(headers.get('Vary') == 'Origin', f'{method} {target}: cors-vary')
    return int(status_line.split()[1]), headers, body


with tempfile.TemporaryDirectory(prefix='eveos-http-cache-') as directory:
    payload = bytes(range(256)) * 3 + b'eveos-static-fixture'
    pathlib.Path(directory, 'fixture.bin').write_bytes(payload)
    handler = functools.partial(Handler, directory=directory)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection(*server.server_address, timeout=2)
    try:
        original_socket = None
        for method in ('GET', 'HEAD', 'GET'):
            connection.request(method, '/fixture.bin?v=123456789abc',
                               headers={'Origin': 'http://localhost:3210'})
            response = connection.getresponse()
            body = response.read()
            check(response.status == 200 and response.version == 11, f'static-{method}: http11-ok')
            check(response.getheader('Content-Length') == str(len(payload)),
                  f'static-{method}: accurate-length')
            check(body == (b'' if method == 'HEAD' else payload), f'static-{method}: exact-body')
            check(response.getheader('Cache-Control') == 'no-cache', f'static-{method}: revalidate')
            check(response.getheader('Access-Control-Allow-Origin') == 'http://localhost:3210',
                  f'static-{method}: local-cors')
            check(not response.will_close and connection.sock is not None,
                  f'static-{method}: persistent')
            if original_socket is None:
                original_socket = connection.sock
            check(connection.sock is original_socket, f'static-{method}: same-socket')
        connection.close()

        cases = [
            ('GET', '/api/no-length', 200, b'{"ok":true}'),
            ('GET', '/api/failure', 500, b'{"error":true}'),
            ('GET', '/api/send-error', 500, None),
            ('OPTIONS', '/api/no-length', 204, b''),
        ]
        for method, target, expected_status, expected_body in cases:
            status, headers, body = raw_response(server.server_address, method, target)
            check(status == expected_status, f'{method} {target}: status')
            if expected_body is not None:
                check(body == expected_body, f'{method} {target}: complete-body')
                check(headers.get('Content-Length') is None, f'{method} {target}: legacy-no-length')
            check(headers.get('Access-Control-Allow-Methods') == 'GET, POST, OPTIONS',
                  f'{method} {target}: cors-methods')
            check(headers.get('Access-Control-Allow-Headers') ==
                  'Content-Type, X-Requested-With, X-EveOS-Provider-Capture, X-EveOS-Provider-File-Auth',
                  f'{method} {target}: cors-headers')
            check(headers.get('Access-Control-Max-Age') == '86400', f'{method} {target}: cors-max-age')

        for origin, expected in [
            (None, '*'), ('null', '*'), ('file://', '*'),
            ('http://localhost:3210', 'http://localhost:3210'),
            ('https://127.0.0.1:3210', 'https://127.0.0.1:3210'),
            ('https://untrusted.example', None), ('http://localhost.evil.example', None),
        ]:
            _, headers, _ = raw_response(server.server_address, 'GET', '/api/no-length', origin)
            check(headers.get('Access-Control-Allow-Origin') == expected, f'cors-origin: {origin}')
            check(len(headers.get_all('Access-Control-Allow-Origin', [])) == (expected is not None),
                  f'cors-single-origin: {origin}')
        _, headers, _ = raw_response(server.server_address, 'GET', '/api/prepopulated',
                                     'http://localhost:3210')
        check(headers.get_all('Access-Control-Allow-Origin') == ['https://prepopulated.example'],
              'cors-prepopulated-origin-preserved')
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        check(not thread.is_alive(), 'fixture-server-stopped')

print(json.dumps({'checks': checks}))
`;

let pythonResult;

function main() {
    const serverSource = read('server/python-server.py');
    const helperSource = read('server_modules/eveos_http_headers.py');
    const cacheMethod = helperSource.slice(helperSource.indexOf('    def _send_cache_control(self):'));
    assert(serverSource.includes('from server_modules.eveos_http_headers import EveOSHTTPHeadersMixin'),
        'server must import the shared HTTP response policy');
    assert(/class CORSHTTPRequestHandler\(EveOSHTTPHeadersMixin,\s*http\.server\.SimpleHTTPRequestHandler\)/
        .test(serverSource), 'server must inherit the HTTP policy before the stdlib handler');
    assert(!serverSource.includes('    def end_headers(self):')
        && !serverSource.includes('    def _send_cache_control(self):')
        && !/^\s+protocol_version\s*=/m.test(serverSource),
    'server must use the tested shared header policy');
    assert(cacheMethod.includes('no-store, no-cache, must-revalidate'),
        'API responses must remain private and uncacheable');
    assert(cacheMethod.includes('self.send_header("Cache-Control", "no-cache")'),
        'localhost static assets must revalidate before browser reuse');
    assert(!/max-age|immutable/i.test(cacheMethod),
        'static EveOS assets must not regain long-lived localhost caching');

    const entrySources = [
        'EveOS.html',
        'server/gemini_chat_interface.html',
        'server/server_monitor.html',
        'tools/World-Book/app/index.html',
        'tools/workshop/MatrixBackground-V2-Upgrading.html'
    ].map(read).join('\n');
    const versions = [...entrySources.matchAll(/[?&]v=([0-9a-f]{12})(?=[&#"'`\s)])/gi)]
        .map((match) => match[1]);
    assert(versions.length >= 10,
        'runtime entry points must expose generated content fingerprints');
    assert(new Set(versions).size >= 5,
        'runtime entry points unexpectedly share a single manual cache key');

    pythonResult = spawnSync('python', ['-B', '-c', PYTHON_SOURCE], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
    });
    assert(!pythonResult.error && pythonResult.status === 0,
        `http-loopback: ${pythonResult.error?.message || pythonResult.stderr.trim().split('\n').at(-1)
            || `Python exited ${pythonResult.status}`}`);
    const { checks } = JSON.parse(pythonResult.stdout);
    assert(Number.isInteger(checks) && checks > 0, 'http-loopback: missing check count');
    console.log(`RUNTIME_ASSET_CACHE_SMOKE_OK (${versions.length} fingerprinted entry references; ${checks} HTTP checks)`);
}

try {
    main();
} catch (error) {
    const artifact = path.join(ROOT, 'data/runtime/smoke-results/runtime-asset-cache.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({
        test: 'runtime-asset-cache', error: error.stack,
        python: pythonResult && {
            status: pythonResult.status, signal: pythonResult.signal,
            stdout: pythonResult.stdout, stderr: pythonResult.stderr,
            error: pythonResult.error?.message
        }
    }, null, 2));
    console.error(`RUNTIME_ASSET_CACHE_SMOKE_FAIL: ${error.message}\nDiagnostics: ${artifact}`);
    process.exitCode = 1;
}
