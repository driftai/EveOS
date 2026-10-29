// Listener-facing Piano history, metadata, seek, and inbox projections.
// The embedded Piano app remains the sole persistence and playback owner.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready) return;
  let host = null;
  let state = { controls: null, queue: null, progress: null, media: null };
  let editingId = '';
  let timeline = { songId: '', index: 0, total: 0, status: 'idle' };
  let completedSongId = '';
  let seekDragging = false, seekDraft = 0, seekHold = 0, seekHoldUntil = 0;
  let sheetSignature = '', sheetElement = null;
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
    const progress=state.progress || {};
    const value=String(progress.sheetPreview ?? media.sheetPreview ?? '');
    const range=progress.sheetHighlight || media.sheetHighlight || {};
    const start=Number(range.start),end=Number(range.end);
    // A status response may momentarily omit an event projection while the
    // corresponding media projection still has the Backend parser's ranges.
    // Never let such an empty update discard an interactive note mid-keypress.
    const progressEvents=Array.isArray(progress.sheetEvents) ? progress.sheetEvents : [];
    const mediaEvents=Array.isArray(media.sheetEvents) ? media.sheetEvents : [];
    const raw=progressEvents.length ? progressEvents : mediaEvents;
    // Only the Backend parser may supply seek indices. Keep all original whitespace.
    let cursor=0;
    const events=[];
    for(const item of raw.slice(0,160)){
      const a=Number(item?.start),b=Number(item?.end),index=Number(item?.index);
      if(!Number.isSafeInteger(index)||index<1||index>1000000||!Number.isInteger(a)||!Number.isInteger(b)||a<cursor||b<=a||b>value.length)continue;
      events.push({index,start:a,end:b});cursor=b;
    }
    const signature=JSON.stringify([value,events,events.length?null:[start,end]]);
    if(sheetElement!==node||sheetSignature!==signature){
      // Projection updates may replace spans while a user is navigating with
      // keyboard. Restore focus ONLY to the same still-present Backend event.
      const focused=node.contains(document.activeElement) ? document.activeElement?.dataset?.pxmEventIndex : '';
      sheetElement=node;sheetSignature=signature;node.replaceChildren();
      if(!value){node.textContent='Load a sheet to preview its notation here.';return;}
      if(events.length){
        let offset=0;
        for(const event of events){
          if(event.start>offset)node.append(document.createTextNode(value.slice(offset,event.start)));
          const target=document.createElement('span');
          target.textContent=value.slice(event.start,event.end);
          target.dataset.pxmEventIndex=String(event.index);
          target.dataset.pxmStart=String(event.start);target.dataset.pxmEnd=String(event.end);
          target.setAttribute('role','button');target.tabIndex=0;
          target.setAttribute('aria-label',`Seek to event ${event.index}: ${target.textContent}`);
          target.title=`Seek to event ${event.index}`;
          node.append(target);offset=event.end;
        }
        if(offset<value.length)node.append(document.createTextNode(value.slice(offset)));
      }else if(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=value.length){
        node.append(document.createTextNode(value.slice(0,start)));
        const mark=document.createElement('mark');mark.textContent=value.slice(start,end);mark.className='piano-pxm-sheet-current';node.append(mark);
        node.append(document.createTextNode(value.slice(end)));
      }else node.textContent=value;
      if(focused){
        const replacement=[...node.querySelectorAll('[data-pxm-event-index]')]
          .find(target=>target.dataset.pxmEventIndex===focused);
        replacement?.focus({preventScroll:true});
      }
    }
    for(const target of node.querySelectorAll('[data-pxm-event-index]')){
      target.classList.toggle('piano-pxm-sheet-current',Number(target.dataset.pxmStart)===start&&Number(target.dataset.pxmEnd)===end);
    }
  }
  function seekEvent(target) {
    const index=Number(target?.dataset?.pxmEventIndex);
    if(!Number.isSafeInteger(index)||index<1||index>1000000)return;
    if(ports.command?.('progress:seek',{eventIndex:index})===false)return;
    seekDragging=false;seekHold=index;seekHoldUntil=Date.now()+2200;
    render();
  }
  function timelineProjection(media, current) {
    const progress=state.progress||{},songId=String(current?.id||''),changed=songId!==timeline.songId;
    const status=String(progress.status||media.status||'idle');
    const observedTotal=Math.max(0,Number(progress.total||0),Number(media.total||0));
    const total=observedTotal||(!changed?Number(timeline.total||0):0);
    const observedIndex=changed?Number(media.index||0):Number(progress.total?progress.index:media.index||0);
    let index=Math.max(0,Math.min(total||observedIndex,observedIndex));
    if(changed){timeline={songId,index:0,total,status};completedSongId='';seekDragging=false;seekDraft=0;seekHold=0;seekHoldUntil=0;}
    if(status==='complete'&&total){
      index=total;completedSongId=songId;
    }else if(completedSongId===songId&&total&&(status==='idle'||status==='stopped')){
      // The Backend has finished: keep 100% through the following idle poll.
      index=total;
    }else if(completedSongId===songId&&['countdown','playing','paused'].includes(status)){
      // A new attempt on the same song starts a new visual timeline.
      completedSongId='';
    }
    // The Backend prepares event 1 as its next seek target on an idle sheet.
    // Prepared is not played: show zero elapsed events without altering Backend state.
    if((status==='idle'||status==='stopped')&&index<=1&&!seekDragging&&!seekHold&&completedSongId!==songId){
      index=0;timeline.index=0;
    }
    if(index>0||timeline.index===0)timeline.index=index;
    if(total)timeline.total=total;
    timeline.status=status;
    if(seekDragging)return{...timeline,index:seekDraft,total:timeline.total||total};
    if(seekHold&&Date.now()<seekHoldUntil&&Math.abs(index-seekHold)>1)return{...timeline,index:seekHold,total:timeline.total||total};
    if(seekHold&&Math.abs(index-seekHold)<=1){seekHold=0;seekHoldUntil=0;}
    return timeline;
  }
  function render() {
    const media=state.media || {}, current=media.current;
    text('[data-pxm-current]',current?.title || 'Nothing playing');
    const auto=current?.automatic_identifiers || {}, ids=current?.identifiers || {};
    const meta=[ids.author || current?.artist,current?.source,auto.event_count ? `${auto.event_count} events` : '',media.durationMs ? duration(media.durationMs) : ''].filter(Boolean).join(' · ');
    text('[data-pxm-current-meta]',meta || 'Choose a song from your Piano library.');
    text('[data-pxm-instrument]',state.controls?.sound?.label ? `Instrument: ${state.controls.sound.label}` : 'Instrument follows Playback setup');
    const projected=timelineProjection(media,current),positionMs=projected.total?Math.round(Number(media.durationMs||0)*projected.index/projected.total):0;
    renderSheetPreview(media);
    const seek=$('[data-pxm-seek]');
    if(seek&&!seekDragging){seek.min='0';seek.max=String(Math.max(1,projected.total||1));seek.value=String(Math.max(0,projected.index||0));seek.disabled=!projected.total;}
    // Explicit fill is independent of the browser's thumb and accent-color geometry.
    const fill=$('[data-pxm-seek-fill]');
    if(fill)fill.style.width=`${projected.total?Math.max(0,Math.min(100,100*projected.index/projected.total)):0}%`;
    const pause=$('[data-pxm-compact-pause]');
    if(pause){pause.textContent=projected.status==='paused'?'Resume':'Pause';pause.disabled=!current?.id||!front.bridgeReady?.()||!['playing','countdown','paused'].includes(projected.status);pause.setAttribute('aria-label',projected.status==='paused'?'Resume current song':'Pause current song');}
    text('[data-pxm-elapsed]',duration(positionMs));
    text('[data-pxm-remaining]',`−${duration(Math.max(0,Number(media.durationMs||0)-positionMs))}`);
    const preset=$('[data-pxm-preset]'); if(preset && media.preset)preset.value=media.preset;
    const favorite=$('[data-af-action="piano-frontend-media-current-favorite"]');
    if(favorite){favorite.disabled=!current?.id;favorite.textContent=isFavorite(current)?'★ Favorite':'☆ Favorite';favorite.dataset.songId=current?.id||'';}
    const edit=$('[data-af-action="piano-frontend-media-edit-backend"]'); if(edit){edit.disabled=!current?.id;edit.dataset.songId=current?.id||'';}
    const currentEditor=$('[data-af-action="piano-frontend-media-edit-current"]');if(currentEditor){const editable=!!songById(current?.id);currentEditor.disabled=!editable;currentEditor.dataset.songId=editable?current.id:'';}
    const resetEditor=$('[data-af-action="piano-frontend-media-edit-reset"]');if(resetEditor)resetEditor.disabled=!editingId;
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
    text('[data-pxm-editing-label]',`Editing ${song.title||'Untitled'}`);
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
    panel.innerHTML=`<details class="piano-pxm-now"><summary class="piano-pxm-now-summary"><span>SONG CONTROLS</span><strong data-pxm-current>Nothing playing</strong><small>Seek, presets, favorites, and details</small></summary><div class="piano-pxm-now-body"><div class="piano-pxm-now-head"><small data-pxm-current-meta>Choose a song from your Piano library.</small><div class="piano-pxm-now-actions"><button type="button" data-af-action="piano-frontend-media-current-favorite" disabled>☆ Favorite</button><button type="button" data-af-action="piano-frontend-media-edit-backend" disabled>Edit in Backend</button></div></div><div class="piano-pxm-timeline"><span data-pxm-elapsed>0:00</span><div class="piano-pxm-seek-shell"><div class="piano-pxm-seek-track" aria-hidden="true"><span data-pxm-seek-fill></span></div><input data-pxm-seek type="range" min="0" max="1" value="0" step="1" aria-label="Seek through the current Piano song" disabled></div><span data-pxm-remaining>−0:00</span><button type="button" class="piano-pxm-compact-pause" data-pxm-compact-pause data-af-action="piano-frontend-pause" disabled>Pause</button></div><div class="piano-pxm-listener-tools"><label>Playback preset <select data-pxm-preset><option value="natural">Natural</option><option value="fast">Fast Practice</option><option value="slow">Slow Practice</option><option value="custom">Custom</option></select></label><span data-pxm-instrument>Instrument follows Playback setup</span><button type="button" data-af-action="piano-frontend-media-import">Add Songs</button><button type="button" data-af-action="piano-frontend-media-recordings">My Recordings</button></div><details class="piano-pxm-preview"><summary>Song & sheet details</summary><pre data-pxm-sheet-preview>Load a sheet to preview its notation here.</pre></details></div></details><details class="piano-pxm-history"><summary><strong>Recently Played</strong><span>Replay from your shared Auto Player history</span></summary><div data-pxm-history-list></div></details><details class="piano-pxm-inbox"><summary><strong>Incoming Songs</strong><span data-pxm-inbox-count>0 incoming</span></summary><div data-pxm-inbox-list></div></details><details class="piano-pxm-editor"><summary><strong>Song details editor</strong><span>Library metadata is saved by the Backend</span></summary><div class="piano-pxm-editor-actions"><span data-pxm-editing-label>Select a library song to edit</span><button type="button" data-af-action="piano-frontend-media-edit-current" disabled>Load current song</button><button type="button" data-af-action="piano-frontend-media-edit-reset" disabled>Reset changes</button></div><div class="piano-pxm-editor-grid"><label>Title<input data-pxm-edit-title maxlength="180"></label><label>Artist / author<input data-pxm-edit-artist maxlength="90"></label><label>Genres<input data-pxm-edit-genre placeholder="genre, genre"></label><label>Tags<input data-pxm-edit-tags placeholder="tag, tag"></label><label>Rating<input data-pxm-edit-rating type="number" min="0" max="5" step="0.5"></label><label class="piano-pxm-check"><input data-pxm-edit-favorite type="checkbox"> Favorite</label></div><button type="button" data-af-action="piano-frontend-media-save">Save details</button></details>`;
    const queue=c.querySelector('.piano-pxp-queue');(queue||c.querySelector('.piano-frontend-header'))?.after(panel);
    const seek=panel.querySelector('[data-pxm-seek]');
    seek?.addEventListener('pointerdown',event=>{seekDragging=true;seekDraft=Math.max(0,Math.round(Number(event.target.value)||0));});
    seek?.addEventListener('input',event=>{seekDragging=true;seekDraft=Math.max(0,Math.round(Number(event.target.value)||0));render();});
    seek?.addEventListener('change',event=>{seekDragging=false;seekHold=Math.round(Number(event.target.value)||1);seekHoldUntil=Date.now()+2200;if(ports.command?.('progress:seek',{eventIndex:seekHold})===false){seekHold=0;seekHoldUntil=0;}render();});
    seek?.addEventListener('pointercancel',()=>{seekDragging=false;render();});
    const preview=panel.querySelector('[data-pxm-sheet-preview]');
    preview?.addEventListener('click',event=>{const target=event.target.closest?.('[data-pxm-event-index]');if(target&&preview.contains(target))seekEvent(target);});
    preview?.addEventListener('keydown',event=>{
      if(event.key!=='Enter'&&event.key!==' ')return;
      const target=event.target.closest?.('[data-pxm-event-index]');
      if(!target||!preview.contains(target))return;
      event.preventDefault();seekEvent(target);
    });
    panel.querySelector('[data-pxm-preset]')?.addEventListener('change',event=>ports.command?.('playback:preset',{value:event.target.value}));
    render();
  }
  function updateSong(song, overrides={}) {
    const ids=song?.identifiers||{};
    const nextFavorite=overrides.favorite??isFavorite(song);
    if(Object.prototype.hasOwnProperty.call(overrides,'favorite')){
      front.setSongFavorite?.(song.id,nextFavorite);
      if(String(state.media?.current?.id||'')===String(song.id)){
        const current=state.media.current,identifiers=current.identifiers||{},custom=identifiers.custom||{};
        state={...state,media:{...state.media,current:{...current,identifiers:{...identifiers,custom:{...custom,favorite:nextFavorite?'true':'false'}}}}};render();
      }
    }
    const sent=ports.command?.('song:update',{songId:song.id,title:overrides.title??song.title,artist:overrides.artist??ids.author??song.artist,genre:overrides.genre??ids.genre,tags:overrides.tags??ids.tags,rating:overrides.rating??ids.personal_rating,favorite:nextFavorite});
    if(sent===false)front.requestLibrary?.();
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
    else if(name==='edit-current'&&song)openEditor(song.id);
    else if(name==='edit-reset'&&editingId)openEditor(editingId);
    else if(name==='edit-backend'&&target.dataset.songId){
      // A view switch only. Never load a song or mutate the shared playback/queue.
      if(host?.querySelector('[data-audioflix-piano]')?.dataset.pianoView==='frontend')host.querySelector('[data-piano-view-switch]')?.click();
    }
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
