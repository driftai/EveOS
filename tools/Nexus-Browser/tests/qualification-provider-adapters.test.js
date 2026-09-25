const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../extension/providers.js');

const ROOT = path.resolve(__dirname, '../extension/content');

function providerForId(providerId) {
  return PROVIDERS.find((provider) => provider.id === providerId);
}

function source(providerId) {
  const provider = providerForId(providerId);
  const group = provider?.groups?.find((item) => item.expectedAdapter === providerId);
  const files = group?.files || [];
  const entry = files.find((file) => file === 'content/' + providerId + '.js')
    || [...files].reverse().find((file) => file.endsWith('.js'));
  if (!entry) throw new Error('No primary adapter entrypoint registered for ' + providerId);
  return fs.readFileSync(path.resolve(__dirname, '../extension', entry), 'utf8');
}

function providerIds() {
  return PROVIDERS.filter((provider) => provider.qualification?.live).map((provider) => provider.id);
}

test('every live-qualification provider adapter accepts standardized qualification metadata', () => {
  for (const providerId of providerIds()) {
    const code = source(providerId);
    assert.match(code, /qualification\s*=\s*null/, providerId);
    assert.match(code, /msg\.qualification\s*\|\|\s*null/, providerId);
    assert.match(code, /exactOnce/, providerId);
  }
});

test('all provider adapters keep ordinary send behavior separate from exact-once qualification behavior', () => {
  for (const providerId of providerIds()) {
    const code = source(providerId);
    assert.match(code, /qualification\?\.exactOnce\s*===\s*true|exactOnce:\s*qualification\?\.exactOnce\s*===\s*true/, providerId);
  }
});

test('ChatGPT exact-once mode cannot fall through from a failed click into form submission', () => {
  const code = source('chatgpt');
  const exactGuard = code.indexOf("if (exactOnce) throw new Error('ChatGPT qualification prompt was not committed");
  const formFallback = code.indexOf('if (requestComposerSubmit(composer))');
  assert.ok(exactGuard >= 0);
  assert.ok(formFallback > exactGuard);
});

test('Gemini exact-once mode bypasses multi-event click fallback and excludes AI Studio', () => {
  const code = source('gemini');
  assert.match(code, /if \(!exactOnce\) \{\s*triggerClick\(sendControl\)/);
  assert.match(code, /sendControl\.click\(\)/);
  assert.match(code, /AI Studio is excluded from exact-once qualification/);
});

test('Muse requires the explicit exact-once contract for qualification runs', () => {
  const code = source('muse');
  assert.match(code, /qualification\?\.runId && !exactOnce/);
  assert.match(code, /requires the explicit exact-once adapter contract/);
});


test('qualification contract suite is registry-driven and covers every live provider', () => {
  assert.deepEqual(providerIds(), PROVIDERS.filter((provider) => provider.qualification.live).map((provider) => provider.id));
  for (const provider of PROVIDERS.filter((item) => item.qualification.live)) {
    assert.equal(provider.adapterContract.operations.probe, true, provider.id);
    assert.equal(provider.adapterContract.operations.ensureReady, true, provider.id);
    assert.equal(provider.adapterContract.operations.send, true, provider.id);
    assert.equal(provider.adapterContract.operations.observe, true, provider.id);
    assert.equal(provider.adapterContract.operations.captureLatest, true, provider.id);
    assert.equal(provider.adapterContract.operations.recover, true, provider.id);
    assert.equal(provider.adapterContract.operations.health, true, provider.id);
  }
});


test('qualification recovery capture resolves from persisted run ownership, not global target selection', () => {
  const worker = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  assert.match(worker, /assertPromptTarget\(\{ runId: msg\.qualification\.runId \}\)/);
  assert.doesNotMatch(worker, /assertPromptTarget\(\{ runId: msg\.qualification\.runId, providerId: targetProviderId, tabId: targetTabId \}\)/);
});
