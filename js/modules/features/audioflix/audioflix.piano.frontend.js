// Song-first EveOS Piano frontend. The running Piano iframe remains the sole playback owner.
(function (ns) {
    'use strict';
    if (ns.ready) return;
    let root = null;
    let seq = 0;
    let frameSource = '';
    let songs = [];
    let filter = '';
    let sortMode = 'recent';
    let bridgeReady = false;
    let libraryReady = false;
    let lastLibrary = 0;
    let lastStatus = 0;
    let busy = '';
    let state = 'idle';
    let message = 'Connect to Piano to see your songs.';
    const pending = new Map();

    function panel() { return root?.querySelector('[data-audioflix-piano]'); }
    function canvas() { return panel()?.querySelector('[data-piano-frontend]'); }
    function frame() { return panel()?.querySelector('[data-piano-frame]'); }
    function isShowing() { return panel()?.dataset.pianoView === 'frontend'; }
    function isRunning() { return panel()?.dataset.running === 'true'; }
    function origin() {
        const src = frame()?.getAttribute('src');
        if (!src || src === 'about:blank') return '';
        try { const url = new URL(src, location.href); return /^https?:$/.test(url.protocol) ? url.origin : ''; }
        catch (_) { return ''; }
    }
    function apiUrl(path) {
        const src = frame()?.getAttribute('src');
        if (!src || src === 'about:blank') return '';
        try { return new URL(path, new URL(src, location.href)).href; }
        catch (_) { return ''; }
    }
    async function directJson(path) {
        const url = apiUrl(path);
        if (!url || !isRunning()) throw new Error('Piano service is offline.');
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Piano service returned ${response.status}.`);
        return response.json();
    }
    function normalizeSongs(items) {
        return (Array.isArray(items) ? items : []).slice(0, 5000).filter(song => song && typeof song.id === 'string').map(song => ({
            id: song.id,
            title: String(song.title || 'Untitled').slice(0, 180),
            artist: String(song.artist || '').slice(0, 90),
            kind: song.kind === 'recording' || Array.isArray(song.performance) && song.performance.length ? 'recording' : 'song',
            updatedAt: Number(song.updated_at || song.updatedAt || 0)
        }));
    }
    function applyLibrary(items, source = 'bridge') {
        songs = normalizeSongs(items);
        libraryReady = true;
        if (!bridgeReady && source === 'direct') message = songs.length
            ? 'Library loaded. Connecting playback controls…'
            : 'Library is empty. Add songs from Backend tools.';
        else message = songs.length ? 'Your saved Piano songs.' : 'No saved songs yet. Add songs from Backend tools.';
        displayStatus();
    }
    function send(action, songId = '') {
        const target = frame()?.contentWindow;
        const to = origin();
        if (!isRunning() || !target || !to) return false;
        const id = ++seq;
        pending.set(id, action);
        setTimeout(() => {
            if (!pending.has(id)) return;
            const timedOut = pending.get(id);
            pending.delete(id);
            if (busy === timedOut) {
                busy = '';
                message = 'Playback controls did not answer. Library access remains available.';
                displayStatus();
            }
        }, 6000);
        try { target.postMessage({ type: 'eveos:piano-frontend-command', id, action, songId }, to); return true; }
        catch (_) { pending.delete(id); return false; }
    }
    function setNotice(text) { message = text; const node = canvas()?.querySelector('[data-pf-message]'); if (node) node.textContent = message; }
    function sortedSongs() {
        const matching = songs.filter(song => `${song.title} ${song.artist}`.toLowerCase().includes(filter));
        return matching.sort((a, b) => {
            if (sortMode === 'az') return a.title.localeCompare(b.title);
            if (sortMode === 'za') return b.title.localeCompare(a.title);
            if (sortMode === 'type') return a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title);
            return b.updatedAt - a.updatedAt;
        });
    }
    function displaySongs() {
        const target = canvas()?.querySelector('[data-pf-songs]');
        const count = canvas()?.querySelector('[data-pf-count]');
        if (!target) return;
        target.replaceChildren();
        const matching = sortedSongs();
        if (count) count.textContent = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;
        if (!matching.length) {
            const empty = document.createElement('p');
            empty.className = 'piano-frontend-empty';
            empty.textContent = songs.length ? 'No songs match your search.' : isRunning() && libraryReady ? 'No saved songs yet. Add songs from Backend tools.' : isRunning() ? 'Connecting to Piano library…' : 'Start Piano to open your saved songs.';
            target.append(empty); return;
        }
        for (const song of matching) {
            const row = document.createElement('div'); row.className = 'piano-frontend-song';
            const art = document.createElement('span'); art.className = 'piano-frontend-note'; art.textContent = song.kind === 'recording' ? '●' : '♪'; art.setAttribute('aria-hidden', 'true');
            const info = document.createElement('div'); info.className = 'piano-frontend-song-info';
            const title = document.createElement('strong'); title.textContent = song.title;
            const subtitle = document.createElement('small'); subtitle.textContent = [song.artist, song.kind === 'recording' ? 'Recording' : 'Song'].filter(Boolean).join(' · ');
            info.append(title, subtitle);
            const play = document.createElement('button'); play.type = 'button'; play.className = 'piano-frontend-song-play';
            play.dataset.afAction = 'piano-frontend-play'; play.dataset.songId = song.id; play.textContent = 'Play';
            play.setAttribute('aria-label', `Play ${song.title}`); play.disabled = !isRunning() || !bridgeReady || !!busy;
            row.append(art, info, play); target.append(row);
        }
    }
    function displayStatus() {
        const c = canvas(); if (!c) return;
        const status = c.querySelector('[data-pf-playback]');
        if (status) {
            status.dataset.state = !isRunning() ? 'offline' : !bridgeReady ? (libraryReady ? 'library' : 'connecting') : state;
            status.textContent = !isRunning() ? 'Piano offline' : !bridgeReady ? (libraryReady ? 'Library ready' : 'Connecting…') : state === 'playing' ? 'Playing' : state === 'paused' ? 'Paused' : state === 'countdown' ? 'Starting…' : state === 'complete' ? 'Finished' : 'Ready';
        }
        for (const action of ['pause', 'stop', 'refresh']) {
            const button = c.querySelector(`[data-af-action="piano-frontend-${action}"]`);
            if (!button) continue;
            button.disabled = !isRunning() || !!busy || (action !== 'refresh' && !bridgeReady);
        }
        setNotice(message);
        displaySongs();
    }
    function reset() {
        pending.clear(); songs = []; bridgeReady = false; libraryReady = false; lastLibrary = lastStatus = 0; busy = ''; state = 'idle';
        message = isRunning() ? 'Connecting to Piano library…' : 'Start Piano to browse your songs.';
        displayStatus();
    }
    async function loadLibraryDirect() {
        try {
            const data = await directJson('/api/songs');
            if (!bridgeReady) applyLibrary(data.songs, 'direct');
        } catch (_) {
            if (!libraryReady && !bridgeReady) { message = 'Connecting to Piano library…'; displayStatus(); }
        }
    }
    async function loadStatusDirect() {
        try { const data = await directJson('/api/status'); if (!bridgeReady && data?.status) { state = String(data.status); displayStatus(); } }
        catch (_) {}
    }
    function refresh(force = false) {
        if (!isShowing() || !isRunning()) return;
        const now = Date.now();
        if (force || now - lastLibrary > 15000) {
            send('list');
            void loadLibraryDirect();
            lastLibrary = now;
        }
        if (force || now - lastStatus > 4000) {
            send('status');
            void loadStatusDirect();
            lastStatus = now;
        }
    }
    function sync(host) {
        if (host) root = host;
        const source = frame()?.getAttribute('src') || '';
        if (source !== frameSource) { frameSource = source; reset(); }
        if (!isRunning() && (bridgeReady || libraryReady)) reset();
        displayStatus(); refresh();
    }
    function mount(host) {
        root = host;
        const c = canvas();
        if (!c || c.dataset.pfMounted === 'yes') return;
        c.dataset.pfMounted = 'yes';
        c.setAttribute('aria-label', 'Piano songs frontend');
        c.innerHTML = `<div class="piano-frontend-inner">
          <header class="piano-frontend-header">
            <div class="piano-frontend-title"><span class="piano-frontend-kicker">PIANO AUTO PLAYER</span><h2>Piano</h2><p>Your songs, ready to play.</p></div>
            <div class="piano-frontend-transport" aria-label="Piano playback controls"><span class="piano-frontend-state" data-pf-playback role="status">Connecting…</span><button type="button" data-af-action="piano-frontend-pause">Pause / Resume</button><button type="button" data-af-action="piano-frontend-stop">Stop</button></div>
          </header>
          <section class="piano-frontend-library">
            <div class="piano-frontend-library-head"><div><span>LIBRARY</span><h3>Songs <small data-pf-count>0 songs</small></h3></div>
              <div class="piano-frontend-library-tools">
                <label class="piano-frontend-search-label"><span class="sr-only">Find a song</span><input data-pf-search type="search" placeholder="Find a song…" autocomplete="off" aria-label="Search saved songs"></label>
                <label class="piano-frontend-sort-label"><span class="sr-only">Sort songs</span><select data-pf-sort aria-label="Sort saved songs"><option value="recent">Recent</option><option value="az">A–Z</option><option value="za">Z–A</option><option value="type">Type</option></select></label>
                <button type="button" data-af-action="piano-frontend-refresh" title="Refresh Piano library">Refresh</button>
              </div>
            </div>
            <p class="piano-frontend-notice" data-pf-message role="status"></p>
            <div data-pf-songs class="piano-frontend-song-list"></div>
          </section>
        </div>`;
        c.querySelector('[data-pf-search]')?.addEventListener('input', event => { filter = event.target.value.toLowerCase().trim(); displaySongs(); });
        c.querySelector('[data-pf-sort]')?.addEventListener('change', event => { sortMode = event.target.value || 'recent'; displaySongs(); });
        displayStatus();
    }
    function handleAction(target) {
        const action = target?.dataset?.afAction || '';
        if (!action.startsWith('piano-frontend-')) return false;
        if (!isRunning() || busy) return true;
        const command = action.slice('piano-frontend-'.length);
        if (command === 'refresh') { lastLibrary = lastStatus = 0; refresh(true); return true; }
        if (command === 'play' && !songs.some(song => song.id === target.dataset.songId)) return true;
        if (!['play', 'pause', 'stop'].includes(command)) return true;
        if (!bridgeReady) { setNotice('Playback controls are still connecting. Your library is available.'); return true; }
        busy = command; setNotice(command === 'play' ? 'Loading song and starting playback…' : 'Sending playback command…');
        if (!send(command, command === 'play' ? target.dataset.songId : '')) {
            busy = ''; setNotice('Piano playback controls are not connected. Try Refresh.');
        }
        displayStatus(); return true;
    }
    window.addEventListener('message', event => {
        if (!root || event.source !== frame()?.contentWindow || event.origin !== origin()) return;
        if (event.data?.type === 'piano:eveos-frontend-ready') {
            bridgeReady = true; lastLibrary = lastStatus = 0; message = libraryReady ? 'Your saved Piano songs.' : 'Loading Piano library…'; displayStatus(); refresh(true); return;
        }
        if (event.data?.type === 'piano:eveos-library-changed') { lastLibrary = 0; refresh(true); return; }
        if (event.data?.type !== 'piano:eveos-frontend-response') return;
        const data = event.data;
        const action = pending.get(data.id); if (!action) return;
        pending.delete(data.id); bridgeReady = true;
        if (data.error) { if (busy === action) busy = ''; message = String(data.error).slice(0, 180); }
        else if (action === 'list' && Array.isArray(data.songs)) applyLibrary(data.songs, 'bridge');
        else if (action === 'status') state = String(data.status || 'idle');
        else if (busy === action) { busy = ''; message = action === 'play' ? 'Song sent to Piano player.' : 'Playback command completed.'; lastStatus = 0; }
        displayStatus();
    });
    Object.assign(ns, { ready: true, mount, sync, refresh, handleAction });
})(window.EveAudioflixPianoFrontend = window.EveAudioflixPianoFrontend || {});
