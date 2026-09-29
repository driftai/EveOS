window.EveWorldBookNarrationClips = window.EveWorldBookNarrationClips || {};

(function (clips) {
    'use strict';
    if (clips.ready) return;

    const STORE_KEY = 'eveWorldBookNarrationClipRecipesV1';
    const MAX_RECIPES = 400;
    const defaults = Object.freeze({
        enabled: true, engine: 'browser', browserVoice: '', geminiVoice: 'Aoede',
        rate: 1, pitch: 1, volume: 1, strictVerbatim: true, backgroundPrefetch: true,
        preferNativeOutput: true, routeToAudioflix: false, cacheMb: 192, cacheDays: 30
    });
    let source = null;
    let values = [];
    let provider = null;

    const narrationHash = value => window.EveWorldBookNarrationCache?.hash?.(value)
        || String(value || '').split('').reduce((code, char) => ((Math.imul(code ^ char.charCodeAt(0), 16777619)) >>> 0), 2166136261).toString(36);

    function split(text, max = 600) {
        const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
        if (!normalized) return [];
        const pieces = normalized.split(/(?<=[.!?]["'\u201d\u2019)\]]?)\s+/u);
        const output = [];
        let current = '';
        for (const raw of pieces) {
            let part = raw.trim();
            while (part.length > max) {
                let cut = part.lastIndexOf(' ', max);
                if (cut < max * 0.45) cut = max;
                if (current) { output.push(current); current = ''; }
                output.push(part.slice(0, cut).trim());
                part = part.slice(cut).trim();
            }
            if (!part) continue;
            const candidate = current ? current + ' ' + part : part;
            if (candidate.length <= max) current = candidate;
            else { if (current) output.push(current); current = part; }
        }
        if (current) output.push(current);
        return output.filter(value => /[\p{L}\p{N}]/u.test(value));
    }

    function readRecipes() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_error) {
            return {};
        }
    }

    function writeRecipes(recipes) {
        try {
            const entries = Object.entries(recipes)
                .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
                .slice(0, MAX_RECIPES);
            localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch (_error) {}
    }

    function recipeKey(sourceId, text) {
        return `${String(sourceId || 'source')}:${narrationHash(text)}`;
    }

    function baseRecipe(settings = {}) {
        return {
            engine: settings.engine === 'gemini' ? 'gemini' : 'browser',
            browserVoice: String(settings.browserVoice || ''),
            geminiVoice: String(settings.geminiVoice || 'Aoede')
        };
    }

    function fromPassage(text, index, settings, previous = null, dirty = false) {
        const hash = narrationHash(text);
        const persisted = readRecipes()[recipeKey(source?.id, text)];
        const recipe = persisted || previous || baseRecipe(settings);
        const cleanHash = persisted ? hash : String(previous?.cleanHash || hash);
        return {
            index,
            text,
            hash,
            cleanHash,
            engine: recipe.engine === 'gemini' ? 'gemini' : 'browser',
            browserVoice: String(recipe.browserVoice || ''),
            geminiVoice: String(recipe.geminiVoice || 'Aoede'),
            dirty: Boolean(dirty && !persisted && hash !== cleanHash),
            stored: Boolean(persisted || previous?.stored),
            storedKind: persisted?.storedKind || previous?.storedKind || '',
            renderedAt: Number(persisted?.renderedAt || previous?.renderedAt || 0)
        };
    }

    function rebuild(text, settings, markChanges) {
        const passages = split(text);
        const prior = values;
        const exact = new Map(prior.map(item => [item.hash, item]));
        values = passages.map((passage, index) => {
            const sameIndex = prior[index];
            if (sameIndex?.hash === narrationHash(passage)) return { ...sameIndex, index, text: passage };
            const moved = exact.get(narrationHash(passage));
            if (moved) return { ...moved, index, text: passage };
            return fromPassage(passage, index, settings, sameIndex, markChanges);
        });
        if (source) {
            source = { ...source, text: String(text || ''), revision: narrationHash(text) };
        }
        return state();
    }

    function load(nextSource, settings = {}) {
        const text = String(nextSource?.text || '');
        source = {
            id: String(nextSource?.id || 'eveos:local-reader-source'),
            title: String(nextSource?.title || 'EveOS Reader Source'),
            locator: String(nextSource?.locator || 'EveOS'),
            kind: String(nextSource?.kind || 'source'),
            text,
            revision: narrationHash(text)
        };
        values = [];
        rebuild(text, settings, false);
        return state();
    }

    function preview(text, settings = {}) {
        return rebuild(String(text || ''), settings, true);
    }

    function choose(index, patch = {}) {
        const clip = values[Number(index)];
        if (!clip) return null;
        const next = { ...clip };
        if ('engine' in patch) next.engine = patch.engine === 'gemini' ? 'gemini' : 'browser';
        if ('browserVoice' in patch) next.browserVoice = String(patch.browserVoice || '');
        if ('geminiVoice' in patch) next.geminiVoice = String(patch.geminiVoice || 'Aoede');
        const changed = next.engine !== clip.engine
            || next.browserVoice !== clip.browserVoice
            || next.geminiVoice !== clip.geminiVoice;
        next.dirty = clip.dirty || changed;
        next.stored = changed ? false : clip.stored;
        values[next.index] = next;
        return { ...next };
    }

    function markRendered(index, config = {}) {
        const clip = values[Number(index)];
        if (!clip || !source) return null;
        const next = {
            ...clip,
            engine: config.engine === 'gemini' ? 'gemini' : 'browser',
            browserVoice: String(config.browserVoice ?? clip.browserVoice ?? ''),
            geminiVoice: String(config.geminiVoice ?? clip.geminiVoice ?? 'Aoede'),
            dirty: false,
            cleanHash: clip.hash,
            stored: true,
            storedKind: config.engine === 'gemini' ? 'gemini-cache' : 'browser-tts',
            renderedAt: Date.now()
        };
        values[next.index] = next;
        const recipes = readRecipes();
        recipes[recipeKey(source.id, next.text)] = {
            engine: next.engine,
            browserVoice: next.browserVoice,
            geminiVoice: next.geminiVoice,
            storedKind: next.storedKind,
            renderedAt: next.renderedAt,
            updatedAt: Date.now()
        };
        writeRecipes(recipes);
        return { ...next };
    }

    function syncDefaults(settings = {}) {
        const defaults = baseRecipe(settings);
        values = values.map(item => item.stored || item.dirty ? item : {
            ...item,
            engine: defaults.engine,
            browserVoice: defaults.browserVoice,
            geminiVoice: defaults.geminiVoice
        });
        return state();
    }

    function config(index, base = {}) {
        const clip = values[Number(index)];
        if (!clip) return { ...base };
        return {
            ...base,
            engine: clip.engine === 'gemini' ? 'gemini' : 'browser',
            browserVoice: clip.browserVoice ?? base.browserVoice ?? '',
            geminiVoice: clip.geminiVoice || base.geminiVoice || 'Aoede'
        };
    }

    function setProvider(next) {
        provider = typeof next === 'function' ? next : null;
    }

    function reload(settings = {}) {
        if (!provider) throw new Error('This reader source cannot be reloaded.');
        const next = provider();
        const text = typeof next === 'string' ? next : next?.text;
        if (typeof text !== 'string') throw new Error('The latest reader text is unavailable.');
        return preview(text, settings);
    }

    function state() {
        return values.map(item => ({ ...item }));
    }

    Object.assign(clips, {
        ready: true,
        defaults,
        split,
        hash: narrationHash,
        load,
        preview,
        choose,
        syncDefaults,
        config,
        setProvider,
        reload,
        markRendered,
        get: index => values[Number(index)] ? { ...values[Number(index)] } : null,
        state,
        source: () => source ? { ...source } : null,
        sourceText: () => String(source?.text || ''),
        count: () => values.length
    });
})(window.EveWorldBookNarrationClips);
