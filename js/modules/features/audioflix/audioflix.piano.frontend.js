// Song-first EveOS Piano frontend. The running Piano iframe remains the sole playback owner.
(function (ns) {
    'use strict';
    if (ns.ready) return;
    let root = null;
    let seq = 0;
    let frameSource = '';
    let songs = [];
    let filter = '';
    let connected = false;
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
    function send(action, songId = '') {
        const target = frame()?.contentWindow;
        const to = origin();
        if (!isRunning() || !target || !to) return false;
        const id = ++seq;
        pending.set(id, action);
        try { target.postMessage({ type: 'eveos:piano-frontend-command', id, action, songId }, to); return true; }
        catch (_) { pending.delete(id); return false; }
    }
    function setNotice(text) { message = text; const node = canvas()?.querySelector('[data-pf-message]'); if (node) node.textContent = message; }
    function displaySongs() {
        const target = canvas()?.querySelector('[data-pf-songs]');
        const count = canvas()?.querySelector('[data-pf-count]');
        if (!target) return;
        target.replaceChildren();
        const matching = songs.filter(song => `${song.title} ${song.artist}`.toLowerCase().includes(filter));
        if (count) count.textContent = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;
        if (!matching.length) {
            const empty = document.createElement('p');
            empty.className = 'piano-frontend-empty';
            empty.textContent = songs.length ? 'No songs match your search.' : isRunning() ? 'No saved songs yet. Add songs from Backend tools.' : 'Start Piano to open your saved songs.';
            target.append(empty); return;
        }
        for (const song of matching) {
            const row = document.createElement('div'); row.className = 'piano-frontend-song';
            const art = document.createElement('span'); art.className = 'piano-frontend-note'; art.textContent = '♫'; art.setAttribute('aria-hidden', 'true');
            const info = document.createElement('div'); info.className = 'piano-frontend-song-info';
            const title = document.createElement('strong'); title.textContent = song.title;
            const subtitle = document.createElement('small'); subtitle.textContent = [song.artist, song.kind === 'recording' ? 'Recording' : 'Song'].filter(Boolean).join(' · ');
            info.append(title, subtitle);
            const play = document.createElement('button'); play.type = 'button'; play.className = 'piano-frontend-song-play';
            play.dataset.afAction = 'piano-frontend-play'; play.dataset.songId = song.id; play.textContent = 'Play';
            play.setAttribute('aria-label', `Play ${song.title}`); play.disabled = !isRunning() || !!busy;
            row.append(art, info, play); target.append(row);
        }
    }
    function displayStatus() {
        const c = canvas(); if (!c) return;
        const status = c.querySelector('[data-pf-playback]');
        if (status) status.textContent = !isRunning() ? 'Piano offline' : !connected ? 'Connecting…' : state === 'playing' ? 'Playing' : state === 'paused' ? 'Paused' : state === 'countdown' ? 'Starting…' : state === 'complete' ? 'Finished' : 'Ready';
        for (const action of ['pause', 'stop', 'refresh']) {
            const b = c.querySelector(`[data-af-action="piano-frontend-${action}"]`);
            if (b) b.disabled = !isRunning() || !!busy || (action !== 'refresh' && !connected);
        }
        setNotice(message);
        displaySongs();
    }
    function reset() {
        pending.clear(); songs = []; connected = false; lastLibrary = lastStatus = 0; busy = ''; state = 'idle';
        message = isRunning() ? 'Connecting to Piano library…' : 'Start Piano to browse your songs.';
        displayStatus();
    }
    function refresh(force = false) {
        if (!isShowing() || !isRunning()) return;
        const now = Date.now();
        if (force || now - lastLibrary > 15000) { if (send('list')) lastLibrary = now; }
        if (force || now - lastStatus > 4000) { if (send('status')) lastStatus = now; }
    }
    function sync(host) {
        if (host) root = host;
        const source = frame()?.getAttribute('src') || '';
        if (source !== frameSource) { frameSource = source; reset(); }
        if (!isRunning() && connected) reset();
        displayStatus(); refresh();
    }
    function mount(host) {
        root = host;
        const c = canvas();
        if (!c || c.dataset.pfMounted === 'yes') return;
        c.dataset.pfMounted = 'yes';
        c.setAttribute('aria-label', 'Piano songs frontend');
        c.innerHTML = `<div class="piano-frontend-inner">
          <header class="piano-frontend-header"><div><span class="piano-frontend-kicker">PIANO AUTO PLAYER</span><h2>Piano</h2><p>Pick a song and play. Playback uses the route selected in Backend tools.</p></div>
            <div class="piano-frontend-transport"><span data-pf-playback role="status">Connecting…</span><button type="button" data-af-action="piano-frontend-pause">Pause / Resume</button><button type="button" data-af-action="piano-frontend-stop">Stop</button></div></header>
          <section class="piano-frontend-library"><div class="piano-frontend-library-head"><div><span>YOUR LIBRARY</span><h3>Songs <small data-pf-count>0 songs</small></h3></div>
            <div class="piano-frontend-library-tools"><label class="piano-frontend-search-label"><span class="sr-only">Find a song</span><input data-pf-search type="search" placeholder="Find a song…" autocomplete="off" aria-label="Search saved songs"></label><button type="button" data-af-action="piano-frontend-refresh">Refresh</button></div></div>
            <p class="piano-frontend-notice" data-pf-message role="status"></p><div data-pf-songs class="piano-frontend-song-list"></div></section>
        </div>`;
        c.querySelector('[data-pf-search]')?.addEventListener('input', event => { filter = event.target.value.toLowerCase().trim(); displaySongs(); });
        displayStatus();
    }
    function handleAction(target) {
        const action = target?.dataset?.afAction || '';
        if (!action.startsWith('piano-frontend-')) return false;
        if (!isRunning() || busy) return true;
        const command = action.slice('piano-frontend-'.length);
        if (command === 'refresh') { lastLibrary = 0; refresh(true); return true; }
        if (command === 'play' && !songs.some(s => s.id === target.dataset.songId)) return true;
        if (!['play', 'pause', 'stop'].includes(command)) return true;
        busy = command; setNotice(command === 'play' ? 'Loading song and starting playback…' : 'Sending playback command…');
        if (!send(command, command === 'play' ? target.dataset.songId : '')) {
            busy = ''; setNotice('Piano is not connected. Try Refresh.');
        }
        displayStatus(); return true;
    }
    window.addEventListener('message', event => {
        if (!root || event.source !== frame()?.contentWindow || event.origin !== origin()) return;
        if (event.data?.type === 'piano:eveos-frontend-ready') { connected = true; lastLibrary = lastStatus = 0; refresh(true); return; }
        if (event.data?.type === 'piano:eveos-library-changed') { lastLibrary = 0; refresh(true); return; }
        if (event.data?.type !== 'piano:eveos-frontend-response') return;
        const data = event.data;
        const action = pending.get(data.id); if (!action) return;
        pending.delete(data.id); connected = true;
        if (data.error) { if (busy === action) busy = ''; message = String(data.error).slice(0, 180); }
        else if (action === 'list' && Array.isArray(data.songs)) {
            songs = data.songs.slice(0, 5000).filter(s => s && typeof s.id === 'string').map(s => ({ id: s.id, title: String(s.title || 'Untitled').slice(0, 180), artist: String(s.artist || '').slice(0, 90), kind: s.kind === 'recording' ? 'recording' : 'song' }));
            message = songs.length ? 'Your saved Piano songs.' : 'No saved songs yet. Add songs from Backend tools.';
        } else if (action === 'status') state = String(data.status || 'idle');
        else if (busy === action) { busy = ''; message = action === 'play' ? 'Song sent to Piano player.' : 'Playback command completed.'; lastStatus = 0; }
        displayStatus();
    });
    Object.assign(ns, { ready: true, mount, sync, refresh, handleAction });
})(window.EveAudioflixPianoFrontend = window.EveAudioflixPianoFrontend || {});
