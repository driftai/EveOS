const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('canonical efficiency commands stay exposed through package scripts', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['extension:reload'],
    'node ../../tools/extensions/assemble.cjs --write && node scripts/dexctl.js reload-extension');
  assert.equal(pkg.scripts['validate:shared'], 'npm run stabilize && npm run providers:verify && npm run doctor');
  assert.equal(pkg.scripts['handoff:verify'], 'node scripts/handoff.js --verify');
  assert.equal(pkg.scripts.diagnose, 'node scripts/failure-snapshot.js');
});

test('README keeps the engineering efficiency workflow discoverable', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /ENGINEERING-EFFICIENCY\.md/);
  assert.match(readme, /npm run validate:shared/);
  assert.match(readme, /npm run extension:reload/);
  assert.match(readme, /npm run handoff:verify/);
  assert.match(readme, /Eve Engineering N/);
});

test('efficiency guardrails preserve the load-bearing runtime rules', () => {
  const guide = fs.readFileSync(path.join(root, 'ENGINEERING-EFFICIENCY.md'), 'utf8');
  for (const phrase of [
    'Streaming activity must stay cheap',
    'Exact-once is load-bearing',
    'passive exact-once recovery journal',
    'promptClaimedRequestId',
    'globally selected',
    '--warm-tab-id <id>',
    'npm run soak:headed',
    'Do not use Growth/production room bindings or existing conversation history as soak targets',
    'https://chatgpt.com/',
    'https://muse.ai/thread/new',
    '--cleanup-stale',
    'primes each fresh disposable surface with a neutral plain-text echo',
    'Each relay response must be exactly `SOAK_ACK[dex-turn-...]`',
    'closing bracket is intentional',
    'Ordinary ChatGPT sends must also tolerate a provisional composer disappearing',
    'capture-recover the final from that exact tab without resending the prompt',
    'Never finalize merely because a partial capture stayed unchanged for a short fixed window',
    'transient/status activity is not reliable completion evidence',
    'keep the long incomplete-text settle even when the watcher previously saw only status-derived activity',
    'Cleanup is offline-only',
    'Provider-control mutation ACKs are durable boundaries',
    'flush the updated state before sending `provider_control_result`',
    'Read-only provider-control commands must not force whole-state flushes',
    'provider-adapter-revision.js',
    'Online managed workers stay bounded and localhost-orchestrated',
    'only registry-declared spawnable providers may be created',
    'brand-new background tab with `active:false`',
    'stable non-destructive first-turn readiness before binding the worker into Dex',
    'currently 4',
    'a trailing provider-control command pauses the current relay',
    'use `despawn_agent` so the exact provider tab is closed',
    'close it instead of leaking an orphan worker',
    'a correct first worker reply is not the end of a managed-worker proof',
    'do not emit `[[DEX:DONE]]`',
    'one final room `status` proving the worker is gone and the room is idle',
    'delete the disposable proof room with `delete_room`',
    'one-use qualification/test rooms must not accumulate',
    'DEX_CONTROL_MANAGED_WORKERS_PRESENT',
    'DEX_CONTROL_ROOM_BUSY',
    'user-facing closing report',
    'npm run rooms:cleanup-disposable',
    'localhost-only',
    'the two pre-tagging legacy proof rooms',
    'Prompt delivery needs an explicit commit proof',
    'Typing the prompt into a provider composer is not delivery',
    'permit exactly one submit side effect for that dispatch',
    'composer departure or an empty text box is evidence only, not a commit proof',
    'PROMPT_DELIVERY_UNCOMMITTED',
    'Eve Engineering line rollover',
    'npm run handoff:verify',
    'Engineer numbers are lineage labels only',
    'Only the exact SHA/state actually validated',
    'raw `node -e',
    'Never manually press Enter on a stranded provider composer',
    'Failure evidence snapshots',
    'npm run diagnose'
  ]) {
    assert.ok(guide.includes(phrase), `missing efficiency guardrail: ${phrase}`);
  }
});
