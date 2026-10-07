'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Agentic loader graph is prepared sequentially and before Gemini layout mount', () => {
    const entry = read('js/modules/gemini/html_loaders/agentic/agentic.js');
    const loader = read('js/modules/gemini/html_loaders/agentic/core/agenticScriptLoader.js');
    const config = read('js/modules/gemini/html_loaders/agentic/core/agenticLoaderConfig.js');
    const session = read('js/modules/gemini/html_loaders/agentic/sess_ctrl/sessionControlsUILoader.js');
    const htmlInit = read('js/modules/gemini/html_loaders/html_initialization_loaders.js');

    assert.match(entry, /window\.AgenticHtmlLoadersReady\s*=\s*loadCoreScriptsSequentially\(\)/);
    assert.match(entry, /script\.async\s*=\s*false/);

    assert.match(loader, /let agenticUiLoaderPreparationPromise = null/);
    assert.match(loader, /for \(const scriptPath of window\.AgenticLoaderConfig\.SCRIPTS\)/);
    assert.match(loader, /await yieldAgenticLoaderTurn\(\)/);
    assert.doesNotMatch(loader, /Promise\.all\(promises\)/);
    assert.match(loader, /window\.prepareAgenticUILoaderScripts = prepareAgenticUILoaderScripts/);

    assert.match(config, /sessionControlsSettingsDialogUILoader\.js\?v=[a-f0-9]{12}/);
    assert.match(session, /typeof window\.loadSessionControlsSettingsDialog === 'function'/);
    assert.match(session, /script\.async\s*=\s*false/);

    const readyIndex = htmlInit.indexOf('await window.AgenticHtmlLoadersReady');
    const prepareIndex = htmlInit.indexOf('await window.prepareAgenticUILoaderScripts()');
    const layoutIndex = htmlInit.indexOf('await window.initializeLayoutUIHtmlComponents()');
    assert.ok(readyIndex >= 0, 'HTML bootstrap must await Agentic core readiness');
    assert.ok(prepareIndex > readyIndex, 'Agentic UI preparation must follow core readiness');
    assert.ok(layoutIndex > prepareIndex, 'Agentic UI loader graph must finish before Layout mutates the provider DOM');
});
