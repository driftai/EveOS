window.EveWorldBookNarrationCompanion = window.EveWorldBookNarrationCompanion || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    const POPUP_NAME = 'eveWorldBookReaderCompanion';
    const GEMINI_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'];
    const styles = `
        :host { color-scheme: dark; font-family: Georgia, "Times New Roman", serif; }
        * { box-sizing: border-box; } button, input, select { font: inherit; }
        .companion { width:100%; min-width:0; max-height:100vh; overflow:auto; padding:15px; border:1px solid rgba(73,220,230,.34); border-radius:16px; background:radial-gradient(circle at 85% 0,rgba(40,176,187,.17),transparent 35%),#061216; color:#e9fdff; box-shadow:0 22px 70px rgba(0,0,0,.5); }
        .heading,.heading-actions,.controls,.timeline-labels,.route,.defaults { display:flex; align-items:center; }
        .heading { justify-content:space-between; gap:12px; } .heading-actions,.controls { gap:7px; flex-wrap:wrap; }
        .heading span,.route span,.defaults span { color:#61e9f2; font:700 .63rem/1.2 sans-serif; letter-spacing:.13em; text-transform:uppercase; }
        h1 { margin:4px 0 0; overflow:hidden; color:#f5ffff; font-size:1.05rem; text-overflow:ellipsis; white-space:nowrap; }
        button,select { min-height:34px; padding:6px 10px; border:1px solid rgba(95,222,231,.28); border-radius:9px; background:rgba(12,42,48,.82); color:#dbfbfd; }
        button { cursor:pointer; } button:hover { border-color:#68e9f1; background:rgba(21,79,87,.9); }
        button.primary { border-color:rgba(111,236,244,.62); background:linear-gradient(135deg,#238b95,#145f68); }
        button.icon { width:34px; padding:0; } .passage { min-height:48px; margin:12px 0 9px; color:rgba(239,253,255,.8); font-size:.84rem; line-height:1.5; }
        .defaults { align-items:flex-end; gap:8px; flex-wrap:wrap; margin:8px 0 11px; padding:10px; border:1px solid rgba(91,216,225,.14); border-radius:11px; background:rgba(3,18,22,.58); }
        .defaults label { display:grid; gap:4px; min-width:130px; flex:1 1 145px; color:rgba(218,244,246,.63); font:700 .65rem/1.2 sans-serif; }
        .defaults select { width:100%; min-width:0; }
        .clips { display:grid; gap:7px; max-height:245px; overflow:auto; margin:0 0 10px; padding-right:2px; }
        .clip { display:grid; grid-template-columns:minmax(0,1fr) 112px 150px auto; gap:7px; align-items:center; padding:9px; border:1px solid rgba(91,216,225,.14); border-radius:11px; background:rgba(3,18,22,.56); }
        .clip.is-active { border-color:rgba(101,232,240,.5); } .clip.is-dirty { border-color:rgba(255,88,92,.72); background:rgba(78,18,22,.32); }
        .clip-copy { min-width:0; } .clip-copy strong { display:flex; gap:7px; align-items:center; font:700 .72rem/1.2 sans-serif; }
        .clip-copy p { margin:4px 0 0; overflow:hidden; color:rgba(239,253,255,.68); font-size:.72rem; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }
        .clip-copy small { color:rgba(214,243,245,.5); font:600 .62rem/1.2 sans-serif; } .clip.is-dirty .clip-copy small { color:#ff8f94; }
        .clip select { width:100%; min-width:0; padding-inline:7px; font-size:.68rem; } .clip button { min-width:58px; font-size:.68rem; }
        .timeline { width:100%; accent-color:#65e8f0; } .timeline-labels { justify-content:space-between; gap:8px; color:rgba(214,243,245,.58); font:.68rem/1.4 sans-serif; font-variant-numeric:tabular-nums; }
        .controls { justify-content:center; margin-top:11px; } .route { justify-content:space-between; gap:12px; margin-top:12px; padding-top:10px; border-top:1px solid rgba(91,216,225,.15); color:rgba(218,244,246,.63); font:.69rem/1.4 sans-serif; }
        .route label { display:flex; align-items:center; gap:7px; white-space:nowrap; } .route input { width:86px; accent-color:#65e8f0; }
        .companion.is-collapsed .passage,.companion.is-collapsed .defaults,.companion.is-collapsed .clips,.companion.is-collapsed .timeline-wrap,.companion.is-collapsed .route { display:none; }
        .companion.is-collapsed .controls { margin-top:10px; }
        @media(max-width:560px){.clip{grid-template-columns:minmax(0,1fr) 1fr 1fr}.clip button{grid-column:1/-1}.companion{padding:11px}.route{align-items:flex-start;flex-direction:column}}
    `;

    let latestState = null, activeRoot = null, activeHost = null, activeWindow = null, mode = '', clipSignature = '';
    const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
    const bridge = () => window.EveWorldBookNarrationBridge;
    const formatTime = seconds => {
        const safe = Math.max(0, Number(seconds) || 0);
        return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
    };
    const command = (action, data = null) => bridge()?.broadcastCommand?.(action, { data, queueIfUnavailable: false }) || 0;
    const browserVoices = () => window.speechSynthesis?.getVoices?.() || [];

    function clearSurface(target = activeWindow) {
        if (target && target === activeWindow) activeWindow = null;
        if (activeHost?.isConnected) activeHost.remove();
        activeRoot = activeHost = null; mode = ''; clipSignature = '';
    }

    function close() {
        const target = activeWindow;
        clearSurface(target);
        try { if (target && !target.closed) target.close(); } catch (_error) {}
    }

    function template() {
        return `<style>${styles}</style><main class="companion">
            <div class="heading"><div><span>World Book voice layer</span><h1 data-reader-title>No source selected</h1></div>
            <div class="heading-actions"><button type="button" data-reader-action="reload-source" title="Reload changed Notes text">&#8635;</button><button class="icon" type="button" data-reader-action="collapse" title="Collapse companion">-</button><button class="icon" type="button" data-reader-action="close" title="Close companion">&times;</button></div></div>
            <p class="passage" data-reader-passage>Open Reader Library and choose something to hear.</p>
            <div class="defaults"><span>Defaults</span><label>Engine<select data-reader-default-engine><option value="browser">Browser TTS</option><option value="gemini">Gemini Live</option></select></label><label>Browser voice<select data-reader-browser-voice></select></label><label>Gemini voice<select data-reader-gemini-voice></select></label></div>
            <div class="clips" data-reader-clips hidden></div>
            <div class="timeline-wrap"><input class="timeline" data-reader-progress type="range" min="0" max="1000" value="0" aria-label="Reader progress"><div class="timeline-labels"><span data-reader-clip>Ready</span><span data-reader-time>0:00 / 0:00</span></div></div>
            <div class="controls"><button type="button" data-reader-action="previous" title="Previous clip">&#9664;</button><button class="primary" type="button" data-reader-action="play">Play</button><button type="button" data-reader-action="stop">Stop</button><button type="button" data-reader-action="next" title="Next clip">&#9654;</button><button type="button" data-reader-action="open-library">Library</button></div>
            <div class="route"><div><span>Output</span><small data-reader-route>Local reader output</small></div><label>Volume <input data-reader-volume type="range" min="0" max="1" step="0.05" value="1"></label></div>
        </main>`;
    }

    function fillVoiceSelect(select, type, selected) {
        if (!select) return;
        select.replaceChildren();
        if (type === 'gemini') {
            GEMINI_VOICES.forEach(name => select.append(new Option(name, name)));
        } else {
            select.append(new Option('Browser default', ''));
            browserVoices().forEach(voice => select.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI)));
        }
        select.value = selected || '';
        if (select.value !== String(selected || '') && select.options.length) select.selectedIndex = 0;
    }

    function renderClips(state) {
        const host = activeRoot?.querySelector('[data-reader-clips]');
        if (!host) return;
        const items = Array.isArray(state.clips) ? state.clips : [];
        host.hidden = !items.length;
        const signature = JSON.stringify(items.map(item => [item.hash,item.dirty,item.engine,item.browserVoice,item.geminiVoice,item.storedKind]),) + ':' + state.index;
        if (signature === clipSignature) return;
        clipSignature = signature;
        host.replaceChildren();
        items.forEach((item, index) => {
            const row = document.createElement('article');
            row.className = `clip${item.dirty ? ' is-dirty' : ''}${index === Number(state.index || 0) ? ' is-active' : ''}`;
            const copy = document.createElement('div'); copy.className = 'clip-copy';
            const title = document.createElement('strong'); title.textContent = `Clip ${index + 1}`;
            const status = document.createElement('small');
            status.textContent = item.dirty ? 'Changed · regenerate' : item.storedKind === 'gemini-cache' ? 'Gemini cached' : item.storedKind === 'browser-tts' ? 'Browser TTS recipe' : 'Ready';
            const preview = document.createElement('p'); preview.textContent = item.text;
            copy.append(title, status, preview);

            const engine = document.createElement('select'); engine.dataset.clipEngine = String(index);
            engine.append(new Option('Browser TTS','browser'), new Option('Gemini Live','gemini')); engine.value = item.engine;
            const voice = document.createElement('select'); voice.dataset.clipVoice = String(index);
            fillVoiceSelect(voice, item.engine, item.engine === 'gemini' ? item.geminiVoice : item.browserVoice);
            const regen = document.createElement('button'); regen.type = 'button'; regen.dataset.clipRegen = String(index); regen.textContent = 'Regen';
            row.append(copy, engine, voice, regen); host.append(row);
        });
    }

    function syncDefaults() {
        if (!activeRoot) return;
        const value = bridge()?.settings?.() || {};
        const engine = activeRoot.querySelector('[data-reader-default-engine]');
        if (engine) engine.value = value.engine === 'gemini' ? 'gemini' : 'browser';
        fillVoiceSelect(activeRoot.querySelector('[data-reader-browser-voice]'), 'browser', value.browserVoice);
        fillVoiceSelect(activeRoot.querySelector('[data-reader-gemini-voice]'), 'gemini', value.geminiVoice || 'Aoede');
    }

    function bind(root) {
        root.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.clipRegen !== undefined) return void command('regenerate-clip', { index: Number(button.dataset.clipRegen) });
            const action = button.dataset.readerAction;
            if (!action) return;
            if (action === 'close') return close();
            if (action === 'collapse') {
                const panel = root.querySelector('.companion'); panel?.classList.toggle('is-collapsed');
                button.textContent = panel?.classList.contains('is-collapsed') ? '+' : '-'; return;
            }
            if (action === 'open-library') return bridge()?.openReader?.();
            if (action === 'play' && latestState?.status === 'playing') return command('pause');
            command(action);
        });
        root.addEventListener('change', event => {
            const target = event.target;
            if (target.matches('[data-reader-progress]')) return void command('seek-progress', { value:Number(target.value)||0, autoplay:latestState?.status==='playing' });
            if (target.matches('[data-reader-volume]')) return void bridge()?.saveSettings?.({ volume:Number(target.value)||0 });
            if (target.matches('[data-reader-default-engine]')) return void bridge()?.saveSettings?.({ engine:target.value });
            if (target.matches('[data-reader-browser-voice]')) return void bridge()?.saveSettings?.({ browserVoice:target.value });
            if (target.matches('[data-reader-gemini-voice]')) return void bridge()?.saveSettings?.({ geminiVoice:target.value });
            if (target.dataset.clipEngine !== undefined) return void command('set-clip-engine', { index:Number(target.dataset.clipEngine), engine:target.value });
            if (target.dataset.clipVoice !== undefined) return void command('set-clip-voice', { index:Number(target.dataset.clipVoice), voice:target.value });
        });
    }

    function mount(host, targetWindow = null, nextMode = 'inline') {
        clearSurface(); activeHost = host; activeWindow = targetWindow; mode = nextMode;
        activeRoot = host.shadowRoot || host.attachShadow({ mode: 'open' });
        activeRoot.innerHTML = template(); bind(activeRoot); syncDefaults();
        if (targetWindow) targetWindow.addEventListener('pagehide', () => { if (activeWindow === targetWindow) clearSurface(targetWindow); }, { once:true });
        update(latestState); return activeRoot;
    }

    function mountWindow(targetWindow, nextMode) {
        const doc = targetWindow.document; doc.title = 'EveOS Reader Companion';
        doc.documentElement.style.cssText = 'color-scheme:dark;background:#02090c;';
        doc.body.style.cssText = 'min-height:100vh;margin:0;padding:8px;box-sizing:border-box;background:#02090c;';
        doc.body.replaceChildren(); const host = doc.createElement('div'); doc.body.append(host);
        mount(host, targetWindow, nextMode); targetWindow.focus?.();
    }

    function mountInline() {
        let host = document.querySelector('[data-world-book-reader-companion]');
        if (!host) {
            host = document.createElement('div'); host.dataset.worldBookReaderCompanion = '';
            Object.assign(host.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:'2147483000',width:'min(620px, calc(100vw - 36px))'});
            document.body.append(host);
        }
        mount(host, null, 'inline');
    }

    async function open(seed = null) {
        if (seed) latestState = seed;
        if (activeRoot && (!activeWindow || !activeWindow.closed)) { activeWindow?.focus?.(); return mode; }
        if (window.documentPictureInPicture?.requestWindow) {
            try { const pip = await window.documentPictureInPicture.requestWindow({ width:640,height:620 }); mountWindow(pip,'picture-in-picture'); return mode; } catch (_error) {}
        }
        let popup = null;
        try { popup = window.open('',POPUP_NAME,'popup=yes,width=650,height=640,resizable=yes,scrollbars=yes'); } catch (_error) {}
        if (popup) { mountWindow(popup,'popup'); return mode; }
        mountInline(); return mode;
    }

    function update(nextState) {
        if (nextState && typeof nextState === 'object') latestState = nextState;
        if (!activeRoot) return syncAudioflixSummary();
        const state = latestState || {}, ratio = clamp(state.overallRatio), passageRatio = clamp(state.passageRatio);
        const duration = Math.max(0,Number(state.passageDuration)||0), status = String(state.status||'idle');
        activeRoot.querySelector('[data-reader-title]').textContent = state.source?.title || 'No source selected';
        activeRoot.querySelector('[data-reader-passage]').textContent = state.passage || 'Open Reader Library and choose something to hear.';
        activeRoot.querySelector('[data-reader-progress]').value = Math.round(ratio*1000);
        activeRoot.querySelector('[data-reader-clip]').textContent = state.passageCount ? `Clip ${Number(state.index||0)+1} of ${state.passageCount} / ${status}${state.dirtyCount ? ` · ${state.dirtyCount} changed` : ''}` : 'Ready';
        activeRoot.querySelector('[data-reader-time]').textContent = `${formatTime(duration*passageRatio)} / ${formatTime(duration)}`;
        activeRoot.querySelector('[data-reader-action="play"]').textContent = status==='playing'?'Pause':status==='paused'?'Resume':'Play';
        const reload = activeRoot.querySelector('[data-reader-action="reload-source"]');
        if (reload) reload.hidden = state.source?.id !== 'eveos:scratchpad';
        const settings = bridge()?.settings?.() || {};
        activeRoot.querySelector('[data-reader-route]').textContent = state.output==='native-default'?'Windows default output':state.output==='audioflix'?'Audioflix native output':state.engine==='browser'?'Browser TTS':'Browser audio output';
        activeRoot.querySelector('[data-reader-volume]').value = Number(settings.volume??1);
        syncDefaults(); renderClips(state); syncAudioflixSummary();
    }

    function renderAudioflixSummary() {
        const state = latestState || bridge()?.getState?.();
        return `<section class="audioflix-reader-route-card" data-audioflix-reader-summary${state?.source?'':' hidden'}><div><span>World Book Reader</span><strong data-reader-summary-title></strong><small data-reader-summary-state></small></div><button type="button" data-af-action="open-reader-companion">Detach controls</button></section>`;
    }

    function syncAudioflixSummary() {
        const state = latestState || bridge()?.getState?.();
        document.querySelectorAll?.('[data-audioflix-reader-summary]')?.forEach(host => {
            host.hidden = !state?.source;
            host.querySelector('[data-reader-summary-title]').textContent = state?.source?.title || 'No reader source';
            host.querySelector('[data-reader-summary-state]').textContent = state?.passageCount ? `Clip ${Number(state.index||0)+1} of ${state.passageCount} / ${state.status||'ready'}` : 'Open Reader Library to choose a source';
        });
    }

    window.speechSynthesis?.addEventListener?.('voiceschanged', () => { if (activeRoot) { syncDefaults(); clipSignature=''; renderClips(latestState||{}); } });
    window.addEventListener('eve:world-book-narration-settings', () => { syncDefaults(); clipSignature=''; renderClips(latestState||{}); });
    window.addEventListener('beforeunload', close, { once:true });
    Object.assign(ns,{ready:true,open,close,update,renderAudioflixSummary,syncAudioflixSummary,getMode:()=>mode,getState:()=>latestState});
})(window.EveWorldBookNarrationCompanion);
