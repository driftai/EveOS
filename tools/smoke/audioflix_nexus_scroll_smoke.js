/**
 * audioflix_nexus_scroll_smoke.js
 *
 * Pressing Play in Nexus Audio Link threw you back to the top of the list.
 *
 * The results list scrolls inside ITSELF -- it carries max-height plus overflow-y, so it is a
 * separate scroll container from the panel around it. rerender() restored the panel's scroll and
 * the info body's scroll, but nothing restored this one, and rerender rebuilds the overlay wholesale
 * via innerHTML. Playing a track rerenders. So every Play on anything below the fold rebuilt the
 * list at scrollTop 0 and you had to scroll back down to reach the next track.
 *
 * Keyed by type on purpose: music and sounds each render their own results container, and a single
 * remembered offset would put one list at the other's position.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const A = path.join(ROOT, 'js', 'modules', 'features', 'audioflix');

function assert(condition, message) {
    if (!condition) throw new Error('ASSERT FAILED: ' + message);
}

/** Minimal stand-in for the two results containers inside the overlay. */
function makeOverlay(entries) {
    const nodes = entries.map(([type, scrollTop]) => ({ dataset: { afNexusResults: type }, scrollTop }));
    return {
        nodes,
        querySelectorAll: (selector) => (selector === '[data-af-nexus-results]' ? nodes : [])
    };
}

function loadNexusUi() {
    const sandbox = { console: { log() {}, warn() {}, error() {} }, document: { createElement: () => ({}) } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(A, 'audioflix.nexus.ui.js'), 'utf8'), sandbox);
    return sandbox.window.EveAudioflixNexusUi;
}

function extractRerender(source) {
    const declaration = /^([ \t]*)function\s+rerender\s*\([^)]*\)\s*\{/m.exec(source);
    assert(declaration, 'the actual rerender declaration must exist, regardless of its parameter list');
    const bodyStart = declaration.index + declaration[0].length;
    const end = new RegExp('^' + declaration[1] + '\\}', 'm').exec(source.slice(bodyStart));
    assert(end, 'the actual rerender function must have an identifiable closing boundary');
    return source.slice(declaration.index, bodyStart + end.index + end[0].length);
}

function exerciseActualRerender(source, ui, activeTab, transientAccepted, transientRequested, retained = false) {
    const calls = [], initialOffsets = [['music', 640], ['sound', 120]];
    let nodes = makeOverlay(initialOffsets).nodes;
    let panel = { scrollTop: 280, scrollLeft: 45 }, info = { scrollTop: 310 }, library = {};
    let rebuilds = 0, markup = '', rebuiltOffsets = null;
    const overlay = {
        hidden: false,
        querySelectorAll: selector => selector === '[data-af-nexus-results]' ? nodes : [],
        querySelector: selector => selector === '.audioflix-panel' ? panel
            : selector === '.audioflix-info-body' ? info : selector === '.audioflix-library-host' ? library : null
    };
    Object.defineProperty(overlay, 'innerHTML', {
        get: () => markup,
        set(value) {
            calls.push('rebuild'); markup = value; rebuilds += 1;
            // A real innerHTML replacement destroys old containers and their offsets. Swap result
            // order too, so restoration must follow music/sound identity rather than DOM position.
            nodes = makeOverlay([['sound', 0], ['music', 0]]).nodes;
            panel = { scrollTop: 0, scrollLeft: 0 }; info = { scrollTop: 0 }; library = {};
            rebuiltOffsets = { results: nodes.map(node => node.scrollTop), panelTop: panel.scrollTop,
                panelLeft: panel.scrollLeft, infoTop: info.scrollTop };
        }
    });
    const original = { nodes, panel, info, library };
    const window = {
        EveAudioflixNexusUi: {
            captureScroll(root) { calls.push('capture'); return ui.captureScroll(root); },
            restoreScroll(root, saved) { calls.push('restore'); return ui.restoreScroll(root, saved); }
        },
        EveAudioflixAudio: { attachWaveform() { calls.push('waveform'); } },
        EveAudioflixTransport: { sync(root) { assert(root === overlay, 'transport sync stays on the same overlay'); calls.push('transport'); } },
        EveAudioflixLayerVoices: { render() { calls.push('layers'); } },
        EveWorldBookNarrationCompanion: { syncAudioflixSummary() { calls.push('narration'); } },
        EveAudioflixRouting: { populateOutputSelectors() { calls.push('routing'); } },
        EveAudioflixState: { getRevision() { calls.push('revision'); return 17; } }
    };
    // An already-mounted Piano exercises the retained path. Every non-Piano
    // full rebuild in this test intentionally leaves the optional owner absent.
    if (retained) window.EveAudioflixPianoRetain = {
        patch(target, html, tab) {
            assert(target === overlay, 'retention patches the live overlay');
            assert(html === '<fixture-rebuilt-panel>', 'retention receives fresh tab markup');
            assert(tab === activeTab, 'retention receives the requested AudioFlix tab');
            calls.push('retain');
            return true;
        }
    };
    const context = vm.createContext({ window, overlay, activeTab, lastTab: activeTab,
        activeInfoItem: null, activeInfoType: 'music', lastRenderedRevision: -1,
        uiPanel: { transient(root) { assert(root === overlay, 'transient projection uses the same overlay'); calls.push('transient'); return transientAccepted; } },
        updateStatusDOM() { calls.push('status'); },
        renderPanel() { calls.push('render'); return '<fixture-rebuilt-panel>'; }
    });
    vm.runInContext(source, context, { timeout: 1000, filename: 'actual-audioflix-rerender.js' });
    vm.runInContext(`rerender(${transientRequested})`, context, { timeout: 1000 });
    assert(nodes.find(node => node.dataset.afNexusResults === 'music').scrollTop === 640,
        'actual rerender preserves the music result offset');
    assert(nodes.find(node => node.dataset.afNexusResults === 'sound').scrollTop === 120,
        'actual rerender preserves the sound result offset independently');
    assert(panel.scrollTop === 280 && panel.scrollLeft === 45, 'actual rerender preserves both panel scroll axes');
    assert(info.scrollTop === 310, 'actual rerender preserves the info body scroll');
    if (transientRequested && transientAccepted) {
        assert(rebuilds === 0 && nodes === original.nodes && panel === original.panel
            && info === original.info && library === original.library,
        'accepted transient projection cannot replace library, result containers, panel, or info body');
        assert(calls.join(',') === 'transient,status,transport',
            'accepted transient projection returns after status and transport, without capture/rebuild/restore');
        assert(context.lastRenderedRevision === -1, 'transient projection does not manufacture a structural render revision');
    } else if (retained) {
        assert(rebuilds === 0 && nodes === original.nodes && panel === original.panel &&
            info === original.info && library === original.library,
        'retained Piano must not destroy Nexus results or its original panel nodes');
        assert(calls.join(',') ===
            ['capture', 'render', 'retain', 'restore', 'waveform', 'transport', 'layers',
                'narration', 'routing', 'revision'].join(','),
        'retained rerender must still preserve capture/restore and downstream updates');
        assert(context.lastRenderedRevision === 17 && context.lastTab === activeTab,
        'retained rerender updates the normal revision and tab tracking');
    } else {
        assert(rebuilds === 1 && nodes !== original.nodes && panel !== original.panel
            && info !== original.info && library !== original.library, 'full path really replaces the old containers');
        assert(rebuiltOffsets.results.every(value => value === 0) && rebuiltOffsets.panelTop === 0
            && rebuiltOffsets.panelLeft === 0 && rebuiltOffsets.infoTop === 0,
        'rebuild simulation resets offsets before the actual restoration executes');
        const expected = ['capture', 'render', 'rebuild', 'restore', 'waveform', 'transport', 'layers', 'narration', 'routing', 'revision'];
        if (transientRequested) expected.unshift('transient');
        assert(calls.join(',') === expected.join(','), 'actual full rerender captures before rebuilding and restores before downstream projection');
        assert(context.lastRenderedRevision === 17 && context.lastTab === activeTab, 'full rerender records the current tab and state revision');
    }
}

function main() {
    const ui = loadNexusUi();
    assert(typeof ui.captureScroll === 'function' && typeof ui.restoreScroll === 'function',
        'the Nexus module owns capturing and restoring its own list scroll');

    // ---- a rerender must not move the list ----
    const before = makeOverlay([['music', 640], ['sound', 120]]);
    const seen = ui.captureScroll(before);
    const after = makeOverlay([['music', 0], ['sound', 0]]);   // freshly rebuilt by innerHTML
    ui.restoreScroll(after, seen);
    assert(after.nodes[0].scrollTop === 640,
        'the music list returns to where it was, so Play does not throw you back to the top');
    assert(after.nodes[1].scrollTop === 120, 'and the sounds list keeps its own separate position');

    // ---- the two lists must not swap positions ----
    const swapped = makeOverlay([['sound', 0], ['music', 0]]);
    ui.restoreScroll(swapped, seen);
    assert(swapped.nodes[0].scrollTop === 120 && swapped.nodes[1].scrollTop === 640,
        'positions follow the type, not the order the containers happen to render in');

    // ---- a list that was at the top stays there ----
    const fresh = makeOverlay([['music', 0]]);
    ui.restoreScroll(fresh, ui.captureScroll(makeOverlay([['music', 0]])));
    assert(fresh.nodes[0].scrollTop === 0, 'an untouched list is left alone');

    // ---- absent containers must not throw ----
    ui.restoreScroll(makeOverlay([]), seen);
    ui.restoreScroll(null, seen);
    ui.restoreScroll(makeOverlay([['music', 0]]), null);

    // ---- and rerender actually calls them, or none of the above matters ----
    const rerender = fs.readFileSync(path.join(A, 'audioflix.ui.js'), 'utf8');
    const scoped = extractRerender(rerender);
    const captureAt = scoped.indexOf('captureScroll');
    const renderAt = scoped.indexOf('const markup = renderPanel()');
    const retentionAt = scoped.indexOf('EveAudioflixPianoRetain?.patch?.');
    const fallbackAt = scoped.indexOf('overlay.innerHTML = markup');
    const restoreAt = scoped.indexOf('restoreScroll');
    assert([captureAt, renderAt, retentionAt, fallbackAt, restoreAt].every(i => i !== -1),
        'rerender must capture scroll, render once, retain Piano conditionally, restore scroll');
    assert(captureAt < renderAt && renderAt < retentionAt && retentionAt < fallbackAt && fallbackAt < restoreAt,
        'scroll capture must precede either retained or full-rebuild path, with restore afterward');

    assert(extractRerender('function rerender (flag = false) {\n return flag;\n}').includes('flag = false'),
        'scope extraction accepts parameters/defaults and whitespace, not only an empty signature');
    let missingRejected = false;
    try { extractRerender('function rerenderModal() { return; }'); } catch { missingRejected = true; }
    assert(missingRejected, 'a missing rerender function cannot silently yield an empty or unrelated scope');
    exerciseActualRerender(scoped, ui, 'music', false, false);
    exerciseActualRerender(scoped, ui, 'soundboard', false, false);
    exerciseActualRerender(scoped, ui, 'music', true, true);
    exerciseActualRerender(scoped, ui, 'soundboard', true, true);
    exerciseActualRerender(scoped, ui, 'music', false, true);
    // A live Piano must remain mounted even when another AudioFlix tab is selected.
    exerciseActualRerender(scoped, ui, 'piano', false, false, true);
    exerciseActualRerender(scoped, ui, 'music', false, false, true);
    console.log('AUDIOFLIX_NEXUS_SCROLL_SMOKE_OK');
}

try { main(); }
catch (error) {
    const artifact = path.join(ROOT, 'data/runtime/smoke-results/audioflix-nexus-scroll-failure.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2));
    console.error(`AUDIOFLIX_NEXUS_SCROLL_SMOKE_FAIL\n${String(error.stack || error).split('\n').slice(0, 30).join('\n')}\nArtifact: ${artifact}`);
    process.exitCode = 1;
}
