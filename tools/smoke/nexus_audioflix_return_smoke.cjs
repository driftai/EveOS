'use strict';
// Search -> Audioflix return must preserve the already-open Nexus scope and tab.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..', '..');
const form = fs.readFileSync(path.join(root, 'js/modules/features/search-advanced/sa-ui.form.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'js/modules/features/search-advanced/sa-ui.form.template.js'), 'utf8');

function check(hasPriorNexus, hasOpen = true, hasOpenNexus = true) {
    const calls = [];
    const listeners = {};
    const button = { addEventListener(type, callback) { listeners[type] = callback; } };
    const window = {
        EveOS: { SearchAdvanced: { Modules: {
            createUiFormFields: () => ({ byId: id => id === 'nxAudioflixLinkBtn' ? button : null }),
            createUiFormTemplate: () => '<div>Search</div>'
        } } },
        closeModals: () => calls.push('close'),
        EveAudioflix: {
            ...(hasOpen ? { open: () => calls.push('open') } : {}),
            ...(hasOpenNexus ? { openNexus: (type, force) => calls.push('nexus:' + type + ':' + force) } : {})
        }
    };
    const document = {
        body: { insertAdjacentHTML() {} },
        getElementById: () => null,
        querySelector: selector => {
            assert.equal(selector, '#audioflix-overlay .audioflix-nexus-panel');
            return hasPriorNexus && hasOpen ? {} : null;
        }
    };
    vm.runInNewContext(form, { window, document }, { filename: 'sa-ui.form.js' });
    window.EveOS.SearchAdvanced.Modules.createUiFormHelpers({}).createModalIfNeeded();
    assert.equal(typeof listeners.click, 'function');
    listeners.click();
    return calls;
}

assert.deepEqual(check(true), ['close', 'open'], 'return should retain existing tab, facet and scope');
assert.deepEqual(check(false), ['close', 'open', 'nexus:music:true'], 'direct Nexus Search should open the music Nexus');
assert.deepEqual(check(false, false), ['close', 'nexus:music:true'], 'older standalone Nexus hosts remain supported');
assert.deepEqual(check(false, true, false), ['close', 'open'], 'Audioflix without Nexus method still opens');
assert.match(template, />🔎 Nexus Audio Link<\/button>/, 'return action needs explicit Nexus Audio Link label');
assert.doesNotMatch(template, />🎵 Audioflix<\/button>/);
console.log('Nexus Search return smoke: PASS (4 navigation cases + return label)');
