// Dedicated Piano Internal Viewer. It projects the shared Backend queue and never owns playback.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  let host = null, snapshot = ports.snapshot?.() || {}, dragged = '', returnFocus = null, detached = null;
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const queue = () => snapshot.queue || {};
  function button(label, action, fields = {}) {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.dataset.pfivAction = action;
    for (const [key, value] of Object.entries(fields)) node.dataset[key] = String(value); return node;
  }
  function ensure() {
    const c = canvas(); if (!c || c.querySelector('.piano-pfiv-overlay')) return;
    const overlay = document.createElement('div'); overlay.className = 'piano-pfiv-overlay'; overlay.hidden = true;
    overlay.innerHTML = `<section class="piano-pfiv-dialog" role="dialog" aria-modal="true" aria-labelledby="pfiv-title"><header><div><span>PIANO INTERNAL VIEWER</span><h3 id="pfiv-title">Shared Player Queue</h3></div><div><button type="button" data-pfiv-action="detach">Detach</button><button type="button" data-pfiv-action="close" aria-label="Close Internal Viewer">×</button></div></header><div class="piano-pfiv-summary"><strong data-pfiv-now>Nothing playing</strong><span data-pfiv-status>Ready</span></div><div class="piano-pfiv-tools"><button type="button" data-pfiv-action="play">Play queue</button><button type="button" data-pfiv-action="stop">Stop</button><button type="button" data-pfiv-action="previous">Previous</button><button type="button" data-pfiv-action="next">Next</button><button type="button" data-pfiv-action="shuffle">Shuffle</button><button type="button" data-pfiv-action="clear">Clear</button></div><div class="piano-pfiv-list" data-pfiv-list></div><p data-pfiv-note role="status">This viewer uses the existing Piano queue and playback owner.</p></section>`;
    c.append(overlay); overlay.addEventListener('click', event => { if (event.target === overlay) close(); const target=event.target.closest?.('[data-pfiv-action]');if(target)handle(target); });
  }
  function renderList(target, interactive = true) {
    if (!target) return; target.replaceChildren(); const state=queue(), items=Array.isArray(state.items)?state.items:[], manual=state.mode==='manual';
    items.slice(0,500).forEach((item,index)=>{const row=document.createElement('div');row.dataset.queueId=item.queueId;row.dataset.status=item.queueId===state.currentId?'current':index<Number(state.cursor||0)?'played':'queued';row.draggable=interactive&&manual;
      if(interactive){row.addEventListener('dragstart',()=>{dragged=item.queueId;});row.addEventListener('dragover',event=>{if(dragged&&manual)event.preventDefault();});row.addEventListener('drop',event=>{event.preventDefault();if(dragged&&dragged!==item.queueId)ports.command?.('queue:reorder',{queueId:dragged,targetQueueId:item.queueId,after:event.clientY>row.getBoundingClientRect().top+row.offsetHeight/2});});}
      const label=document.createElement('span');label.textContent=`${index+1}. ${item.label||'Untitled'}`;row.append(label);
      if(interactive)row.append(button('Play','item',{queueId:item.queueId}),button('+','duplicate',{queueId:item.queueId}),button('−','remove',{queueId:item.queueId}));target.append(row);});
    if(!items.length){const empty=document.createElement('p');empty.textContent='The shared Player Queue is empty.';target.append(empty);}
  }
  function render() {
    const overlay=canvas()?.querySelector('.piano-pfiv-overlay');if(!overlay)return;const state=queue(),items=state.items||[],current=items.find(item=>item.queueId===state.currentId);
    const now=overlay.querySelector('[data-pfiv-now]'),status=overlay.querySelector('[data-pfiv-status]');if(now)now.textContent=current?.label||'Nothing playing';if(status)status.textContent=`${items.length} queued · ${state.mode||'manual'} mode`;
    renderList(overlay.querySelector('[data-pfiv-list]')); renderDetached();
  }
  function open() { ensure();const overlay=canvas()?.querySelector('.piano-pfiv-overlay');if(!overlay)return;returnFocus=document.activeElement;overlay.hidden=false;render();overlay.querySelector('[data-pfiv-action="close"]')?.focus();ports.command?.('queue:get'); }
  function close(){const overlay=canvas()?.querySelector('.piano-pfiv-overlay');if(overlay)overlay.hidden=true;returnFocus?.focus?.();returnFocus=null;}
  function renderDetached(){if(!detached||detached.closed)return;const state=queue(),items=state.items||[],current=items.find(item=>item.queueId===state.currentId);detached.document.querySelector('[data-now]').textContent=current?.label||'Nothing playing';const list=detached.document.querySelector('[data-list]');renderList(list,false);}
  function detach(){
    detached=window.open('','eveos-piano-internal-viewer','popup,width=720,height=760');const note=canvas()?.querySelector('[data-pfiv-note]');if(!detached){if(note)note.textContent='The browser blocked the detached viewer. Allow popups and try again.';return;}
    detached.document.open();detached.document.write('<!doctype html><meta charset="utf-8"><title>EveOS Piano Internal Viewer</title><style>body{font:14px system-ui;background:#071116;color:#def4f6;padding:20px}h1{font-size:22px}div[data-list]>div{display:flex;gap:8px;padding:10px;border-bottom:1px solid #31555b}div[data-list] span{flex:1}[data-status=current]{background:#15414a}</style><h1>Shared Player Queue</h1><strong data-now></strong><div data-list></div><p>Read-only detached projection. Control playback from EveOS.</p>');detached.document.close();renderDetached();
  }
  function handle(target){const action=target.dataset.pfivAction;if(action==='close')close();else if(action==='detach')detach();else{const map={play:'queue:play',stop:'queue:stop',previous:'queue:previous',next:'queue:next',shuffle:'queue:shuffle',clear:'queue:clear',item:'queue:play-item',duplicate:'queue:duplicate',remove:'queue:remove'};if(map[action])ports.command?.(map[action],{queueId:target.dataset.queueId});}}
  function mount(nextHost){host=nextHost||host;ensure();const toolbar=canvas()?.querySelector('.piano-pfo-actions');if(toolbar&&!toolbar.querySelector('[data-pfiv-open]')){const openButton=button('Internal Viewer','open');openButton.dataset.pfivOpen='';openButton.addEventListener('click',open);toolbar.append(openButton);}}
  const oldMount=front.mount,oldHandle=front.handleAction;front.mount=h=>{oldMount(h);mount(h);};front.handleAction=target=>{if(target?.dataset?.afAction==='piano-frontend-internal-open'){open();return true;}return oldHandle(target);};
  ports.subscribe?.(next=>{snapshot=next||snapshot;render();});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!canvas()?.querySelector('.piano-pfiv-overlay')?.hidden)close();});
  Object.assign(ns,{ready:true,open,close});
})(window.EveAudioflixPianoFrontendInternal=window.EveAudioflixPianoFrontendInternal||{},window.EveAudioflixPianoFrontend,window.EveAudioflixPianoFrontendPorts);
