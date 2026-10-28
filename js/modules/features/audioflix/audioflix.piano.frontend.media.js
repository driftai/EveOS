// Listener-facing Piano history, metadata, seek, and inbox projections.
// The embedded Piano app remains the sole persistence and playback owner.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready) return;
  let host = null;
  let state = { controls: null, queue: null, progress: null, media: null };
  let editingId = '';
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const $ = selector => canvas()?.querySelector(selector);
  const text = (selector, value) => { const node=$(selector); if(node)node.textContent=value; };
  const list = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item).trim()).filter(Boolean);
  const isFavorite = song => song?.identifiers?.custom?.favorite === 'true';
  const duration = ms => {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  function songById(id) { return front.getSongs?.().find(song => String(song.id) === String(id)) || null; }
  function button(label, action, fields = {}) {
    const node=document.createElement('button'); node.type='button'; node.textContent=label; node.dataset.afAction=action;
    for (const [key,value] of Object.entries(fields)) node.dataset[key]=String(value);
    return node;
  }
  function renderHistory() {
    const target=$('[data-pxm-history-list]'); if(!target)return;
    target.replaceChildren();
    const items=state.media?.workspace?.history || [];
    if(!items.length){const empty=document.createElement('span');empty.className='piano-pxm-empty';empty.textContent='Nothing played recently.';target.append(empty);return;}
    for(const item of items.slice(-6).reverse()){
      const replay=button(item.label,'piano-frontend-media-history',{entryId:item.id});
      replay.title=`Replay ${item.label}`; target.append(replay);
    }
  }
  function renderInbox() {
    const target=$('[data-pxm-inbox-list]'); if(!target)return;
    target.replaceChildren();
    const items=state.media?.workspace?.staging || [];
    text('[data-pxm-inbox-count]',`${items.length} incoming`);
    if(!items.length){const empty=document.createElement('span');empty.className='piano-pxm-empty';empty.textContent='No incoming songs.';target.append(empty);return;}
    for(const item of items.slice(0,20)){
      const row=document.createElement('div');row.className='piano-pxm-inbox-row';
      const copy=document.createElement('span');copy.textContent=item.label;
      row.append(copy,button('Accept','piano-frontend-media-inbox-load',{entryId:item.id}),button('Discard','piano-frontend-media-inbox-discard',{entryId:item.id}));target.append(row);
    }
  }
  function renderSheetPreview(media) {
    const node=$('[data-pxm-sheet-preview]'); if(!node)return;
    const fallback='Load a sheet to preview its notation here.';
    const progress=state.progress || {};
    const value=String(progress.sheetPreview ?? media.sheetPreview ?? '');
    const range=progress.sheetHighlight || media.sheetHighlight || {};
    const start=Number(range.start),end=Number(range.end);
    node.replaceChildren();
    if(!value){node.textContent=fallback;return;}
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>value.length){node.textContent=value;return;}
    node.append(document.createTextNode(value.slice(0,start)));
    const current=document.createElement('mark');current.className='piano-pxm-sheet-current';current.textContent=value.slice(start,end);node.append(current);
    node.append(document.createTextNode(value.slice(end)));
  }
  function render() {
    const media=state.media || {}, current=media.current;
    text('[data-pxm-current]',current?.title || 'Nothing playing');
    const auto=current?.automatic_identifiers || {}, ids=current?.identifiers || {};
    const meta=[ids.author || current?.artist,current?.source,auto.event_count ? `${auto.event_count} events` : '',media.durationMs ? duration(media.durationMs) : ''].filter(Boolean).join(' · ');
    text('[data-pxm-current-meta]',meta || 'Choose a song from your Piano library.');
    text('[data-pxm-instrument]',state.controls?.sound?.label ? `Instrument: ${state.controls.sound.label}` : 'Instrument follows Playback setup');
    renderSheetPreview(media);
    const seek=$('[data-pxm-seek]');
    if(seek){seek.max=String(Math.max(1,Number(media.total||1)));seek.value=String(Math.max(0,Number(media.index||0)));seek.disabled=!media.total;}
    text('[data-pxm-elapsed]',duration(media.positionMs));
    text('[data-pxm-remaining]',`−${duration(Math.max(0,Number(media.durationMs||0)-Number(media.positionMs||0)))}`);
    const preset=$('[data-pxm-preset]'); if(preset && media.preset)preset.value=media.preset;
    const favorite=$('[data-af-action="piano-frontend-media-current-favorite"]');
    if(favorite){favorite.disabled=!current?.id;favorite.textContent=isFavorite(current)?'★ Favorite':'☆ Favorite';favorite.dataset.songId=current?.id||'';}
    const edit=$('[data-af-action="piano-frontend-media-edit-backend"]'); if(edit){edit.disabled=!current?.id;edit.dataset.songId=current?.id||'';}
    renderHistory();renderInbox();
  }
  function openEditor(songId) {
    const song=songById(songId);if(!song)return;
    editingId=song.id;const ids=song.identifiers||{};
    $('[data-pxm-edit-title]').value=song.title||'';
    $('[data-pxm-edit-artist]').value=ids.author||song.artist||'';
    $('[data-pxm-edit-genre]').value=list(ids.genre).join(', ');
    $('[data-pxm-edit-tags]').value=list(ids.tags).join(', ');
    $('[data-pxm-edit-rating]').value=ids.personal_rating==null?'':String(ids.personal_rating);
    $('[data-pxm-edit-favorite]').checked=isFavorite(song);
    const details=$('.piano-pxm-editor');details.open=true;details.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  function decorateSongs(target, visible) {
    [...target.querySelectorAll('.piano-frontend-song')].forEach((row,index)=>{
      const song=visible[index];if(!song||row.querySelector('.piano-pxm-song-actions'))return;
      const actions=document.createElement('div');actions.className='piano-pxm-song-actions';
      const fav=button(isFavorite(song)?'★':'☆','piano-frontend-media-favorite',{songId:song.id});fav.title=isFavorite(song)?'Remove favorite':'Add favorite';
      actions.append(fav,button('Details','piano-frontend-media-details',{songId:song.id}));
      const queue=row.querySelector('.piano-pxp-queue-actions');row.insertBefore(actions,queue||null);
    });
  }
  function mount(nextHost) {
    host=nextHost||host;const c=canvas();if(!c||c.querySelector('.piano-pxm-listener'))return;
    const panel=document.createElement('section');panel.className='piano-pxm-listener';
    panel.innerHTML=`<details class="piano-pxm-now"><summary class="piano-pxm-now-summary"><span>SONG CONTROLS</span><strong data-pxm-current>Nothing playing</strong><small>Seek, presets, favorites, and details</small></summary><div class="piano-pxm-now-body"><div class="piano-pxm-now-head"><small data-pxm-current-meta>Choose a song from your Piano library.</small><div class="piano-pxm-now-actions"><button type="button" data-af-action="piano-frontend-media-current-favorite" disabled>☆ Favorite</button><button type="button" data-af-action="piano-frontend-media-edit-backend" disabled>Edit in Backend</button></div></div><div class="piano-pxm-timeline"><span data-pxm-elapsed>0:00</span><input data-pxm-seek type="range" min="1" max="1" value="1" step="1" aria-label="Seek through the current Piano song" disabled><span data-pxm-remaining>−0:00</span></div><div class="piano-pxm-listener-tools"><label>Playback preset <select data-pxm-preset><option value="natural">Natural</option><option value="fast">Fast Practice</option><option value="slow">Slow Practice</option><option value="custom">Custom</option></select></label><span data-pxm-instrument>Instrument follows Playback setup</span><button type="button" data-af-action="piano-frontend-media-import">Add Songs</button><button type="button" data-af-action="piano-frontend-media-recordings">My Recordings</button></div><details class="piano-pxm-preview"><summary>Song & sheet details</summary><pre data-pxm-sheet-preview>Load a sheet to preview its notation here.</pre></details></div></details><details class="piano-pxm-history"><summary><strong>Recently Played</strong><span>Replay from your shared Auto Player history</span></summary><div data-pxm-history-list></div></details><details class="piano-pxm-inbox"><summary><strong>Incoming Songs</strong><span data-pxm-inbox-count>0 incoming</span></summary><div data-pxm-inbox-list></div></details><details class="piano-pxm-editor"><summary><strong>Song details editor</strong><span>Library metadata is saved by the Backend</span></summary><div class="piano-pxm-editor-grid"><label>Title<input data-pxm-edit-title maxlength="180"></label><label>Artist / author<input data-pxm-edit-artist maxlength="90"></label><label>Genres<input data-pxm-edit-genre placeholder="genre, genre"></label><label>Tags<input data-pxm-edit-tags placeholder="tag, tag"></label><label>Rating<input data-pxm-edit-rating type="number" min="0" max="5" step="0.5"></label><label class="piano-pxm-check"><input data-pxm-edit-favorite type="checkbox"> Favorite</label></div><button type="button" data-af-action="piano-frontend-media-save">Save details</button></details>`;
    const queue=c.querySelector('.piano-pxp-queue');(queue||c.querySelector('.piano-frontend-header'))?.after(panel);
    panel.querySelector('[data-pxm-seek]')?.addEventListener('change',event=>ports.command?.('progress:seek',{eventIndex:Math.round(Number(event.target.value))}));
    panel.querySelector('[data-pxm-preset]')?.addEventListener('change',event=>ports.command?.('playback:preset',{value:event.target.value}));
    render();
  }
  function updateSong(song, overrides={}) {
    const ids=song?.identifiers||{};
    ports.command?.('song:update',{songId:song.id,title:overrides.title??song.title,artist:overrides.artist??ids.author??song.artist,genre:overrides.genre??ids.genre,tags:overrides.tags??ids.tags,rating:overrides.rating??ids.personal_rating,favorite:overrides.favorite??isFavorite(song)});
  }
  function handleAction(target) {
    const action=target?.dataset?.afAction||'';if(!action.startsWith('piano-frontend-media-'))return false;
    const name=action.slice('piano-frontend-media-'.length),song=songById(target.dataset.songId);
    if(name==='favorite'&&song)updateSong(song,{favorite:!isFavorite(song)});
    else if(name==='current-favorite'&&song)updateSong(song,{favorite:!isFavorite(song)});
    else if(name==='details')openEditor(target.dataset.songId);
    else if(name==='history')ports.command?.('workspace:history-load',{entryId:target.dataset.entryId});
    else if(name==='inbox-load')ports.command?.('workspace:inbox-load',{entryId:target.dataset.entryId});
    else if(name==='inbox-discard')ports.command?.('workspace:inbox-discard',{entryId:target.dataset.entryId});
    else if(name==='import')ports.command?.('library:import');
    else if(name==='recordings'){canvas()?.querySelector('[data-pxp-scope="recordings"]')?.click();canvas()?.querySelector('.piano-frontend-library')?.scrollIntoView({behavior:'smooth',block:'start'});}
    else if(name==='edit-backend'&&target.dataset.songId){ports.command?.('song:load',{songId:target.dataset.songId});setTimeout(()=>host?.querySelector('[data-piano-view-switch]')?.click(),180);}
    else if(name==='save'){
      const current=songById(editingId);if(current)updateSong(current,{title:$('[data-pxm-edit-title]').value,artist:$('[data-pxm-edit-artist]').value,genre:$('[data-pxm-edit-genre]').value,tags:$('[data-pxm-edit-tags]').value,rating:$('[data-pxm-edit-rating]').value,favorite:$('[data-pxm-edit-favorite]').checked});
    }
    return true;
  }
  const oldMount=front.mount,oldHandle=front.handleAction;
  front.mount=h=>{oldMount(h);mount(h);};
  front.handleAction=target=>handleAction(target)||oldHandle(target);
  ports.subscribe?.(snapshot=>{state=snapshot||state;render();});
  Object.assign(ns,{ready:true,decorateSongs});
})(window.EveAudioflixPianoFrontendMedia=window.EveAudioflixPianoFrontendMedia||{},window.EveAudioflixPianoFrontend,window.EveAudioflixPianoFrontendPorts);
