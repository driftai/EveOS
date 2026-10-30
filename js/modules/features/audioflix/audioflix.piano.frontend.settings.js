// Piano-specific Music-style cards, validated settings, duplicate suggestions and shared queue view.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  let host = null, selectedId = '', draggedQueueId = '', mode = 'settings', snapshot = ports.snapshot?.() || {};
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const $ = selector => canvas()?.querySelector(selector);
  const list = value => (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => String(item).trim()).filter(Boolean);
  const songs = () => front.getSongs?.() || [];
  const songById = id => songs().find(song => String(song.id) === String(id)) || null;
  const custom = song => song?.identifiers?.custom || {};
  const playback = song => {
    const raw = custom(song).piano_playback_v1;
    return raw && typeof raw === 'object' ? raw : {};
  };
  const normalizedTitle = value => String(value || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const sourceKey = song => String(song?.source_url || '').trim().toLowerCase();
  function duplicates(song) {
    const title = normalizedTitle(song?.title), source = sourceKey(song);
    return songs().filter(other => other.id !== song.id).map(other => {
      const hard = !!source && source === sourceKey(other);
      const soft = !hard && !!title && title === normalizedTitle(other.title);
      return hard || soft ? { song: other, level: hard ? 'hard' : 'soft' } : null;
    }).filter(Boolean);
  }
  function makeButton(label, action, fields = {}) {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.dataset.pfsAction = action;
    for (const [key, value] of Object.entries(fields)) node.dataset[key] = String(value);
    return node;
  }
  function ensureModal() {
    const c = canvas(); if (!c || c.querySelector('.piano-pfs-overlay')) return;
    const overlay = document.createElement('div'); overlay.className = 'piano-pfs-overlay'; overlay.style.position = 'fixed'; overlay.style.inset = '12px'; overlay.hidden = true;
    overlay.innerHTML = `<section class="piano-pfs-dialog" role="dialog" aria-modal="true" aria-labelledby="pfs-title">
      <header><div><span>PIANO SONG</span><h3 id="pfs-title">Song settings</h3></div><button type="button" data-pfs-action="close" aria-label="Close Piano song settings">×</button></header>
      <div data-pfs-settings><div class="piano-pfs-grid">
        <label>Title<input data-pfs-title maxlength="180"></label><label>Artist / author<input data-pfs-artist maxlength="90"></label>
        <label>Genres<input data-pfs-genres placeholder="genre, genre"></label><label>Tags<input data-pfs-tags placeholder="tag, tag"></label>
        <label>Rating<input data-pfs-rating type="number" min="0" max="5" step="0.5"></label><label class="piano-pfs-check"><input data-pfs-favorite type="checkbox"> Favorite</label>
        <label>Folder<input data-pfs-folder maxlength="80"></label><label>Group<input data-pfs-group maxlength="80"></label>
      </div><fieldset><legend>Playback overrides</legend><div class="piano-pfs-grid">
        <label>Playback route<select data-pfs-route><option value="inherit">Inherit global default</option><option value="internal">Internal Piano</option><option value="target">Target window</option></select></label>
        <label>Target window<select data-pfs-target><option value="">Inherit / choose at play</option></select></label>
        <label>Piano layout<select data-pfs-layout><option value="">Inherit default</option><option value="61">61-key — C2–C7</option><option value="88">88-key — A0–C8</option></select></label>
        <label>Internal instrument<select data-pfs-sound><option value="">Inherit default</option></select></label>
        <label>Internal volume <output data-pfs-volume-output>Default</output><input data-pfs-volume type="range" min="0" max="100" step="1" value="100"></label>
        <label class="piano-pfs-check"><input data-pfs-volume-inherit type="checkbox" checked> Inherit volume</label>
      </div></fieldset><div class="piano-pfs-disabled"><strong>Localization</strong><span>Not available for live Piano songs yet. Piano Port will support rendered media in a future milestone.</span></div>
      <div data-pfs-source class="piano-pfs-source"></div><div data-pfs-duplicates class="piano-pfs-duplicates"></div>
      <footer><button type="button" data-pfs-action="internal">Open in EveOS</button><span data-pfs-note role="status"></span><button type="button" data-pfs-action="save">Save settings</button></footer></div>
      <div data-pfs-internal hidden><div class="piano-pfs-internal-head"><div><span>PIANO INTERNAL VIEW</span><strong data-pfs-internal-song>Shared Player Queue</strong></div><button type="button" data-pfs-action="settings">Song settings</button></div>
        <div class="piano-pfs-queue-summary"><div><span>NOW</span><strong data-pfs-now>Nothing playing</strong></div><div><span>NEXT</span><strong data-pfs-next>Nothing queued next</strong></div></div>
        <div class="piano-pfs-queue-tools"><select data-pfs-mode aria-label="Queue mode"><option value="manual">Manual</option><option value="ordered">Ordered</option><option value="shuffle">Shuffle</option></select>
          <button type="button" data-pfs-action="queue-play">Play queue</button><button type="button" data-pfs-action="queue-stop">Stop</button><button type="button" data-pfs-action="queue-previous">Previous</button><button type="button" data-pfs-action="queue-next">Next</button><button type="button" data-pfs-action="queue-shuffle">Shuffle</button><button type="button" data-pfs-action="queue-clear">Clear</button></div>
        <div data-pfs-queue-list class="piano-pfs-queue-list"></div></div>
    </section>`;
    c.append(overlay);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); const action=event.target.closest?.('[data-pfs-action]')?.dataset.pfsAction; if(action)handle(action,event.target); });
    overlay.querySelector('[data-pfs-volume]')?.addEventListener('input', renderVolume);
    overlay.querySelector('[data-pfs-volume-inherit]')?.addEventListener('change', renderVolume);
    overlay.querySelector('[data-pfs-mode]')?.addEventListener('change', event => ports.command?.('queue:mode',{value:event.target.value}));
  }
  function renderVolume() {
    const inherit=$('[data-pfs-volume-inherit]')?.checked, slider=$('[data-pfs-volume]'), output=$('[data-pfs-volume-output]');
    if(slider)slider.disabled=inherit;if(output)output.textContent=inherit?'Default':`${slider?.value||100}%`;
  }
  function fillOptions(select, values, first) {
    if(!select)return;select.replaceChildren();const initial=document.createElement('option');initial.value='';initial.textContent=first;select.append(initial);
    for(const item of values||[]){const option=document.createElement('option');option.value=String(item.value);option.textContent=String(item.label||item.value);select.append(option);}
  }
  function open(songId, nextMode='settings') {
    ensureModal(); const song=songById(songId); if(!song)return; selectedId=song.id; mode=nextMode;
    const ids=song.identifiers||{}, settings=playback(song), controls=snapshot.controls||{};
    $('[data-pfs-title]').value=song.title||'';$('[data-pfs-artist]').value=ids.author||song.artist||'';$('[data-pfs-genres]').value=list(ids.genre).join(', ');$('[data-pfs-tags]').value=list(ids.tags).join(', ');
    $('[data-pfs-rating]').value=ids.personal_rating==null?'':String(ids.personal_rating);$('[data-pfs-favorite]').checked=custom(song).favorite==='true';$('[data-pfs-folder]').value=custom(song).piano_folder||'';$('[data-pfs-group]').value=custom(song).piano_group||'';
    fillOptions($('[data-pfs-target]'),controls.targets,'Inherit / choose at play');fillOptions($('[data-pfs-sound]'),controls.sounds,'Inherit default');
    $('[data-pfs-route]').value=settings.route||'inherit';$('[data-pfs-target]').value=settings.targetHint||'';$('[data-pfs-layout]').value=settings.layout||'';$('[data-pfs-sound]').value=settings.instrumentId||'';
    const inherited=settings.internalVolumePercent==null;$('[data-pfs-volume-inherit]').checked=inherited;$('[data-pfs-volume]').value=String(inherited?100:settings.internalVolumePercent);renderVolume();
    $('[data-pfs-source]').textContent=song.source_url?`Source: ${song.source_url}`:`Source: ${song.source||'Local Piano library'}`;renderDuplicates(song);renderMode();
    const overlay=$('.piano-pfs-overlay');overlay.hidden=false;overlay.querySelector('[data-pfs-action="close"]')?.focus();
  }
  function renderDuplicates(song) {
    const target=$('[data-pfs-duplicates]');target.replaceChildren();const matches=duplicates(song);
    if(!matches.length)return;const heading=document.createElement('strong');heading.textContent=`Possible related versions (${matches.length})`;target.append(heading);
    const help=document.createElement('p');help.textContent='Source matches are exact; title matches may be alternate arrangements. Review them without deleting either song.';target.append(help);
    for(const item of matches){const row=document.createElement('div');const label=document.createElement('span');label.textContent=`${item.level==='hard'?'Duplicate source':'Similar title'} · ${item.song.title}`;row.append(label,makeButton('Keep Both','keep-both'));target.append(row);}
  }
  function close(){const overlay=$('.piano-pfs-overlay');if(overlay)overlay.hidden=true;selectedId='';}
  function renderMode(){const settings=$('[data-pfs-settings]'),internal=$('[data-pfs-internal]');if(settings)settings.hidden=mode!=='settings';if(internal)internal.hidden=mode!=='internal';if(mode==='internal')renderQueue();}
  function save() {
    const song=songById(selectedId);if(!song)return;const inherited=$('[data-pfs-volume-inherit]').checked;
    const payload={songId:song.id,title:$('[data-pfs-title]').value,artist:$('[data-pfs-artist]').value,genre:$('[data-pfs-genres]').value,tags:$('[data-pfs-tags]').value,rating:$('[data-pfs-rating]').value,favorite:$('[data-pfs-favorite]').checked,folder:$('[data-pfs-folder]').value,group:$('[data-pfs-group]').value,
      playback:{route:$('[data-pfs-route]').value,targetHint:$('[data-pfs-target]').value||null,layout:$('[data-pfs-layout]').value||null,instrumentId:$('[data-pfs-sound]').value||null,internalVolumePercent:inherited?null:Number($('[data-pfs-volume]').value)}};
    const sent=ports.command?.('song:update',payload);$('[data-pfs-note]').textContent=sent===false?'Backend is unavailable.':'Saving through the Piano Backend…';
  }
  function renderQueue(){const queue=snapshot.queue||{},items=Array.isArray(queue.items)?queue.items:[],current=items.findIndex(item=>item.queueId===queue.currentId),manual=queue.mode==='manual';$('[data-pfs-now]').textContent=current>=0?items[current].label:'Nothing playing';$('[data-pfs-next]').textContent=items[current>=0?current+1:0]?.label||'Nothing queued next';if($('[data-pfs-mode]'))$('[data-pfs-mode]').value=queue.mode||'manual';const target=$('[data-pfs-queue-list]');target.replaceChildren();
    items.slice(0,200).forEach((item,index)=>{const row=document.createElement('div');row.dataset.status=index===current?'current':index<Number(queue.cursor||0)?'played':'queued';row.dataset.queueId=item.queueId;row.draggable=manual;row.title=manual?'Drag to reorder this shared queue entry.':'Switch to Manual mode to drag queue entries.';row.addEventListener('dragstart',()=>{draggedQueueId=item.queueId;row.classList.add('is-dragging');});row.addEventListener('dragend',()=>{draggedQueueId='';row.classList.remove('is-dragging');});row.addEventListener('dragover',event=>{if(manual&&draggedQueueId)event.preventDefault();});row.addEventListener('drop',event=>{event.preventDefault();if(!manual||!draggedQueueId||draggedQueueId===item.queueId)return;const rect=row.getBoundingClientRect();ports.command?.('queue:reorder',{queueId:draggedQueueId,targetQueueId:item.queueId,after:event.clientY>rect.top+rect.height/2});});const label=document.createElement('span');label.textContent=`#${index+1} ${item.label}`;row.append(label,makeButton('Play','queue-item',{queueId:item.queueId}),makeButton('+','queue-duplicate',{queueId:item.queueId}),makeButton('−','queue-remove',{queueId:item.queueId}));target.append(row);});
  }
  function handle(action,target){if(action==='close')close();else if(action==='save')save();else if(action==='internal'){mode='internal';$('[data-pfs-internal-song]').textContent=songById(selectedId)?.title||'Shared Player Queue';renderMode();}else if(action==='settings'){mode='settings';renderMode();}else if(action==='keep-both')target.closest('div')?.remove();else if(action.startsWith('queue-')){const map={play:'queue:play',stop:'queue:stop',previous:'queue:previous',next:'queue:next',shuffle:'queue:shuffle',clear:'queue:clear',item:'queue:play-item',duplicate:'queue:duplicate',remove:'queue:remove'};const key=action.slice(6);ports.command?.(map[key],{queueId:target.dataset.queueId});}}
  function decorate(target,visible){for(const row of target.querySelectorAll('.piano-frontend-song')){const song=visible.find(item=>String(item.id)===String(row.dataset.songId));if(!song||row.querySelector('[data-pfs-settings-button]'))continue;const actions=row.querySelector('.piano-pxm-song-actions')||row;const button=makeButton('⚙','open',{songId:song.id});button.dataset.afAction='piano-frontend-settings-open';button.dataset.pfsSettingsButton='';button.title=`Settings for ${song.title}`;actions.append(button);const dups=duplicates(song);if(dups.length){const details=row.querySelector('.piano-pxp-song-details');const badge=document.createElement('span');badge.className=`piano-pxp-chip piano-pfs-duplicate ${dups.some(item=>item.level==='hard')?'is-hard':'is-soft'}`;badge.textContent=dups.some(item=>item.level==='hard')?'Duplicate source':'Similar title';details?.append(badge);}}}
  function handleOpen(target){if(target?.dataset?.afAction!=='piano-frontend-settings-open')return false;open(target.dataset.songId);return true;}
  const oldMount=front.mount,oldHandle=front.handleAction,oldDecorate=ports.decorateSongs;
  front.mount=h=>{oldMount(h);host=h||host;ensureModal();};front.handleAction=target=>handleOpen(target)||oldHandle(target);ports.decorateSongs=(target,visible,all)=>{oldDecorate(target,visible,all);decorate(target,visible);};
  ports.subscribe?.(next=>{snapshot=next||snapshot;if(mode==='internal'&&!$('.piano-pfs-overlay')?.hidden)renderQueue();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('.piano-pfs-overlay')?.hidden)close();});
  Object.assign(ns,{ready:true,open});
})(window.EveAudioflixPianoFrontendSettings=window.EveAudioflixPianoFrontendSettings||{},window.EveAudioflixPianoFrontend,window.EveAudioflixPianoFrontendPorts);
