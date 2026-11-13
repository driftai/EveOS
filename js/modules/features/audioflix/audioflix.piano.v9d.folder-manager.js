// Piano v9D.6: source-grouped scope chips and compact classifier filters; Backend owns metadata.
(function (ns, front, ports, tax, organizer) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready || !tax?.ready || !organizer?.ready) return;
  let host = null, folder = '', facet = '', facetName = '', selectedSongId = '';
  let choiceTerm = '', memberTerm = '', classifierTerm = {auto:'',custom:''}, busy = false;
  let choiceOpen = false, folderSignature = '', navSignature = '';
  let panelMode = '', panelKind = '', panelName = '', panelSource = '', returnFocus = null;
  const pendingFolders = new Map();
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const $ = selector => canvas()?.querySelector(selector);
  const songs = () => front.getSongs?.() || [];
  const unique = values => tax.unique(values.filter(Boolean)).sort((a,b) => a.localeCompare(b));
  const norm = value => String(value || '').toLowerCase();
  const rawFolders = song => tax.folders(song);
  const foldersOf = song => pendingFolders.get(String(song.id)) || rawFolders(song);
  const groupsOf = song => tax.groups(song);
  const assignedGroups = song => tax.assignedGroups(song);
  const tagsOf = song => tax.list(song?.identifiers?.tags);
  const genreOf = song => tax.list(song?.identifiers?.genre);
  const authoredOf = song => unique(genreOf(song));
  const automaticOf = song => unique(tax.list(song?.automatic_identifiers?.tags));
  const derivedOf = song => unique(tax.classifiers(song).filter(v => !tagsOf(song).includes(v)));
  const labelsFor = items => unique(items.flatMap(derivedOf));
  const classifierSets = items => {const custom=unique(items.flatMap(authoredOf));
    return {custom,auto:unique(items.flatMap(automaticOf)).filter(v=>!custom.includes(v))};};
  const autoOnly = (name,items=scoped()) => classifierSets(items).auto.includes(name);
  const membersFor = (items, name, get = rawFolders) => items.filter(song => get(song).includes(name));
  const membershipPlan = (current, name, add) => add ? tax.append(current, [name]) : tax.remove(current, name);
  const button = (label, action, value = '') => {
    const node=document.createElement('button'); node.type='button'; node.textContent=label;
    node.dataset.p9dAction=action; if(value) node.dataset.p9dValue=value; return node;
  };
  const scoped = (items = songs()) => folder ? items.filter(song => foldersOf(song).includes(folder)) : items;
  const valuesFor = (items, kind) => unique(items.flatMap(song => kind==='groups' ? groupsOf(song)
    : kind==='tags' ? tagsOf(song) : derivedOf(song)));
  function inFacet(song, kind = facet, name = facetName) {
    return !kind || (kind==='groups' ? groupsOf(song) : kind==='tags' ? tagsOf(song) : derivedOf(song)).includes(name);
  }
  const selectedMembers = () => scoped().filter(song => inFacet(song));
  const scopeMembersFor = (kind,name) => kind==='folder' ? membersFor(songs(),name,foldersOf) : scoped().filter(song=>inFacet(song,kind,name));
  const editableClassifier = (kind=facet,name=facetName) => kind==='classifiers' &&
    scopeMembersFor(kind,name).some(song=>genreOf(song).includes(name));
  function reconcile(items) {
    for(const song of items){const saved=pendingFolders.get(String(song.id));
      if(saved && JSON.stringify(rawFolders(song))===JSON.stringify(saved)) pendingFolders.delete(String(song.id));}
  }
  function note(message, state = 'info') {
    const el=$('[data-p9d-note]'); if(el){el.textContent=message;el.dataset.state=state;}
  }
  function reset() {
    folder='';facet='';facetName='';selectedSongId='';choiceTerm='';memberTerm='';choiceOpen=false;
    panelMode='';panelKind='';panelName='';
    const a=$('[data-p9d-member-search]'),b=$('[data-p9d-choice-search]');
    if(a)a.value='';if(b)b.value='';renderManager();
  }
  function renderFolders(items) {
    const choices=$('[data-p9d-folder-choices]');if(!choices)return;
    const available=unique(items.flatMap(foldersOf));
    if(folder && !available.includes(folder)){folder='';facet='';facetName='';}
    const sig=JSON.stringify([available,folder]);
    if(sig===folderSignature)return;
    folderSignature=sig; choices.replaceChildren();
    for(const name of ['',...available]){
      const el=button(name || 'All', 'folder', name);
      el.className='p9d-scope-pill';el.classList.toggle('active',folder===name);
      el.setAttribute('aria-pressed',String(folder===name));
      el.title=name?(folder===name?'Return to All library':`Explore ${name}`):'Show scopes across the complete library';
      if(name){const wrap=document.createElement('span');wrap.className='p9d-scope-entry';
        const pen=button('✎','edit-scope','folder\u0000'+name);pen.className='p9d-edit-trigger';
        pen.title='Edit folder '+name;pen.setAttribute('aria-label','Edit folder '+name);
        pen.setAttribute('aria-controls','p9d-action-panel');pen.setAttribute('aria-expanded',String(panelMode==='edit'&&panelKind==='folder'&&panelName===name));
        wrap.append(el,pen);choices.append(wrap);
      }else choices.append(el);
    }
    const plus=button('+','create-scope','folder');plus.className='p9d-plus-trigger';
    plus.title='Create folder';plus.setAttribute('aria-label','Create folder');choices.append(plus);
    const hint=$('[data-p9d-location]');if(hint)hint.textContent=folder?`Folder / ${folder}`:'All library';
  }
  function renderFacets(items) {
    const scopedItems=scoped(items);
    if(facet && !valuesFor(scopedItems,facet).includes(facetName)){facet='';facetName='';}
    for(const kind of ['groups','tags','classifiers']){
      const values=valuesFor(scopedItems,kind);
      const count=$(`[data-p9d-${kind}-count]`), target=$(`[data-p9d-${kind}]`);
      if(count)count.textContent=`${kind.charAt(0).toUpperCase()+kind.slice(1)} (${values.length})`;
      if(!target)continue;target.replaceChildren();
      const search=norm($(`[data-p9d-${kind}-search]`)?.value),filtered=values.filter(x=>norm(x).includes(search)).slice(0,100);
      const sources=kind==='classifiers'?classifierSets(scopedItems):null;
      const partitions=sources?[['auto',filtered.filter(x=>sources.auto.includes(x))],['custom',filtered.filter(x=>sources.custom.includes(x))]]:[['',filtered]];
      for(const [source,names] of partitions){
        let destination=target;
        if(source){const section=document.createElement('section'),heading=document.createElement('strong');section.className='p9d-classifier-source';heading.textContent=`${source==='auto'?'Auto':'Custom'} (${names.length})`;destination=document.createElement('div');destination.className='p9d-scope-choices';
          section.append(heading,destination);target.append(section);}
        for(const value of names){
          const el=button(value,'facet',kind+'\u0000'+value);
          el.className='p9d-scope-pill';el.classList.toggle('active',facet===kind && facetName===value);
          el.setAttribute('aria-pressed',String(facet===kind && facetName===value));const wrap=document.createElement('span');wrap.className='p9d-scope-entry';
          const automatic=source==='auto';const pen=button(automatic?'ⓘ':'✎','edit-scope',kind+'\u0000'+value+(automatic?'\u0000auto':''));
          pen.className=automatic?'p9d-edit-trigger p9d-inspect-trigger':'p9d-edit-trigger';
          pen.setAttribute('aria-label',(automatic?'Inspect automatic classifier ':'Edit '+kind+' ')+value);
          pen.title=(automatic?'Inspect read-only automatic classifier ':'Edit ')+value;
          pen.setAttribute('aria-controls','p9d-action-panel');pen.setAttribute('aria-expanded',String(panelMode==='edit'&&panelKind===kind&&panelName===value));
          wrap.append(el,pen);destination.append(wrap);
        }
      }
      if(!target.childElementCount)target.textContent=values.length?'No matching scopes.':'No scopes of this type yet.';
    }
    const active=$('[data-p9d-current-scope]');
    if(active)active.textContent=facet?`${facet} / ${facetName}`:(folder?'All scopes in folder':'All library scopes');
    const type=$('[data-p9d-mutation-type]');
    if(type)type.textContent=facet==='classifiers'?(editableClassifier()?
      'This classifier includes an authored Genre. Editing affects Genre fields only; automatic classifiers remain read-only.':
      'Automatically derived classifiers are read-only; open a song’s Settings to edit authored Genres or Tags.'):facet?`Edit ${facetName} membership on songs${folder?' in this folder':''}.`:
      folder?'Edit membership in the selected folder.':'Pick a folder or group/tag scope to manage members.';
  }
  function renderMembers(items) {
    const base=selectedMembers(), shown=base.filter(song=>norm(song.title+' '+(song.artist||'')).includes(norm(memberTerm)));
    const count=$('[data-p9d-members-count]');if(count)count.textContent=`Songs in scope (${base.length})`;
    const box=$('[data-p9d-members]');if(!box)return;box.replaceChildren();
    for(const song of shown.slice(0,120)){
      const row=document.createElement('div');row.className='p9d-member-row';
      const name=document.createElement('span');name.textContent=song.title||'Untitled';
      const settings=button('⚙','edit-song',String(song.id));settings.title='Edit song details';
      const remove=button('Remove','remove-song',String(song.id));
      remove.title='Remove this scope membership only';
      remove.disabled=busy || !front.bridgeReady?.() || (!folder && !facet) ||
        (facet==='classifiers' && !genreOf(song).includes(facetName)) ||
        (facet==='groups' && !assignedGroups(song).includes(facetName));
      row.append(name,settings,remove);box.append(row);
    }
    if(!shown.length)box.textContent=base.length?'No matching songs.':'No songs in this scope.';
    const summary=$('[data-p9d-add-summary]');
    if(summary)summary.textContent=folder?`Within ${folder}`:'Across All';
  }
  // Only nonmembers in the current context can be offered by the picker.
  const eligibleSongs = () => folder && panelKind!=='folder' ? scoped() : songs();
  const scopeName = () => panelMode==='create' ? $('[data-p9d-new-name]')?.value.trim()||'' : panelName;
  function canAddFor(song, kind=panelKind, name=scopeName()) {
    if(!song || !kind || !name || name.length>80)return false;
    if(folder && kind!=='folder' && !foldersOf(song).includes(folder))return false;
    const owner=kind==='groups'?groupsOf:kind==='tags'?tagsOf:kind==='classifiers'?derivedOf:foldersOf;
    return !owner(song).includes(name);
  }
  const canAdd = song => !!panelMode && canAddFor(song);
  function renderChoices() {
    const el=$('[data-p9d-choices]');if(!el)return;
    const possible=panelMode ? eligibleSongs().filter(song=>canAdd(song) &&
      norm(song.title+' '+(song.artist||'')).includes(norm(choiceTerm))) : [];
    if(selectedSongId && !possible.some(song=>String(song.id)===selectedSongId))selectedSongId='';
    el.replaceChildren();
    for(const song of possible.slice(0,60)){
      const choice=button(song.title||'Untitled','pick-song',String(song.id));
      choice.setAttribute('role','option');choice.setAttribute('aria-selected',String(selectedSongId===String(song.id)));
      choice.className='p9d-choose-item';el.append(choice);
    }
    const expanded=choiceOpen && possible.length>0 && !!panelMode;
    el.hidden=!expanded;
    const input=$('[data-p9d-choice-search]');
    if(input){input.setAttribute('aria-expanded',String(expanded));input.setAttribute('aria-activedescendant','');}
    const available=$('[data-p9d-eligible-count]');
    if(available)available.textContent=panelMode ? `${possible.length} eligible songs${possible.length>60?' · first 60 shown':''}` : '';
    const selected=possible.find(song=>String(song.id)===selectedSongId);
    const add=$('[data-p9d-action="add"]');
    if(add){add.hidden=panelMode!=='edit';add.disabled=panelMode!=='edit' || busy || !front.bridgeReady?.() || !canAdd(selected);}
    const create=$('[data-p9d-action="create"]');
    if(create){create.hidden=panelMode!=='create';create.disabled=panelMode!=='create' || busy || !front.bridgeReady?.() || !canAdd(selected);}
  }
  function renderActionPanel() {
    const panel=$('[data-p9d-action-panel]');if(!panel)return;
    panel.hidden=!panelMode;const backdrop=$('[data-p9d-backdrop]');if(backdrop)backdrop.hidden=!panelMode;
    if(!panelMode)return;
    const kindLabel={folder:'Folder',groups:'Group',tags:'Tag',classifiers:'Genre classifier'}[panelKind]||panelKind;
    const title=$('[data-p9d-action-title]');if(title)title.textContent=panelMode==='create'?`Create ${kindLabel}`:
      panelSource==='auto'?`Inspect automatic classifier: ${panelName}`:`Edit ${kindLabel}: ${panelName}`;
    const readOnly=panelKind==='classifiers' && panelMode==='edit' &&
      (panelSource==='auto'||!editableClassifier(panelKind,panelName));
    const help=$('[data-p9d-action-help]');if(help)help.textContent=readOnly ?
      'Automatically generated classifiers are read-only. Edit authored Genres in song Settings.' :
      'Only song metadata memberships change; songs are never deleted.';
    const edit=panelMode==='edit';
    for(const selector of ['[data-p9d-rename-row]','[data-p9d-remove-row]']){
      const node=$(selector);if(node)node.hidden=!edit||readOnly;
    }
    const inspect=$('[data-p9d-inspect-row]');if(inspect){inspect.hidden=!readOnly;
      const count=inspect.querySelector('[data-p9d-inspect-count]');
      if(count)count.textContent=`${scopeMembersFor('classifiers',panelName).length} matching songs in this context`;}
    const create=$('[data-p9d-create-row]');if(create)create.hidden=edit;
    const seed=$('[data-p9d-add-seed]');if(seed)seed.hidden=readOnly;
    for(const action of ['rename','remove-scope']){
      const el=$(`[data-p9d-action="${action}"]`);
      if(el)el.disabled=busy || !front.bridgeReady?.() || readOnly;
    }
    renderChoices();
  }
  function renderManager() {
    if(!$('[data-p9d-editor]'))return;
    const items=songs();reconcile(items);renderFolders(items);renderFacets(items);renderMembers(items);
    const line=$('[data-p9d-context]');if(line)line.textContent=folder?`Folder: ${folder}`:'All library';
    renderActionPanel();
  }
  function renderClassifiers() {
    const row=$('[data-p9d-classifier-splits]');if(!row)return;
    const sets=organizer.adaptiveClassifierSets?.(songs())||classifierSets(songs()),states=['auto','custom'].map(kind=>
      [kind,sets[kind].map(label=>[label,organizer.focusState?.('classifier',label)||0]),classifierTerm[kind]]);
    const sig=JSON.stringify(states);if(sig===navSignature)return;navSignature=sig;
    for(const kind of ['auto','custom']){
      const target=$(`[data-p9d-classifier-list="${kind}"]`),count=$(`[data-p9d-classifier-count="${kind}"]`);
      if(!target)continue;target.replaceChildren();const names=sets[kind];
      if(count)count.textContent=`${kind==='auto'?'Auto':'Custom'} (${names.length})`;
      for(const label of names.filter(x=>norm(x).includes(norm(classifierTerm[kind]))).slice(0,120)){
        const state=organizer.focusState?.('classifier',label)||0;
        const el=button(label,'filter-classifier',label);el.dataset.pfoClassifier=label;
        el.className='p9d-scope-pill';el.classList.toggle('active',state===1);
        el.classList.toggle('is-excluded',state===-1);
        el.setAttribute('aria-pressed',String(state!==0));target.append(el);
      }
      if(!target.childElementCount)target.textContent=names.length?'No matches':'None';
    }
  }
  function payloadFor(song, action, name, nextName='') {
    if(action==='folder')return {songId:song.id,folders:membershipPlan(foldersOf(song),name,!!nextName)};
    if(action==='groups')return {songId:song.id,groups:membershipPlan(assignedGroups(song),name,!!nextName)};
    if(action==='tags')return {songId:song.id,tags:membershipPlan(tagsOf(song),name,!!nextName)};
    if(action==='classifiers')return {songId:song.id,genre:membershipPlan(genreOf(song),name,!!nextName)};
    return null;
  }
  function swapPayload(song, kind, oldName, newName) {
    const list = kind==='folder'?foldersOf(song):kind==='groups'?assignedGroups(song):
      kind==='classifiers'?genreOf(song):tagsOf(song);
    const next=tax.append(tax.remove(list,oldName),[newName]);
    return {songId:song.id,[kind==='folder'?'folders':kind==='classifiers'?'genre':kind]:next};
  }
  async function sendPlan(plan, doneMessage, newFolder = folder, newFacet = facet, newFacetName = facetName) {
    if(!plan.length){note('No eligible songs to change.','error');return;}
    if(plan.length>100){note('This change exceeds 100 songs. Narrow the scope first.','error');return;}
    busy=true;renderManager();let done=0;
    try{
      for(const entry of plan){
        const result=await ports.request?.('song:update',entry.payload);
        if(!result?.ok)throw new Error(result?.error||'Piano Backend did not confirm save');
        if(entry.payload.folders)pendingFolders.set(String(entry.song.id),entry.payload.folders);
        done++;note(`Saved ${done} of ${plan.length} changes…`);
      }
      folder=newFolder;facet=newFacet;facetName=newFacetName;selectedSongId='';choiceTerm='';
      panelMode='';panelKind='';panelName='';choiceOpen=false;
      const input=$('[data-p9d-choice-search]');if(input)input.value='';
      note(doneMessage+' ('+done+' confirmed).','success');
    }catch(error){note(`Stopped after ${done}/${plan.length} saves: ${String(error?.message||error)}. Refresh before retrying.`,'error');}
    finally{busy=false;folderSignature='';front.requestLibrary?.();renderManager();renderClassifiers();}
  }
  function actionPanel(mode, kind, name='', origin='') {
    if(!['folder','groups','tags','classifiers'].includes(kind))return;
    if(panelMode===mode&&panelKind===kind&&panelName===name&&panelSource===origin){
      panelMode='';panelKind='';panelName='';panelSource='';choiceOpen=false;folderSignature='';renderManager();return;
    }
    returnFocus=document.activeElement;
    panelMode=mode;panelKind=kind;panelName=name;panelSource=origin;selectedSongId='';choiceTerm='';choiceOpen=false;
    const input=$('[data-p9d-choice-search]');if(input)input.value='';
    const fresh=$('[data-p9d-new-name]');if(fresh)fresh.value='';
    const rename=$('[data-p9d-rename-name]');if(rename)rename.value=name;
    // Opening an editor never changes the library's selected folder/facet.
    folderSignature='';renderManager();
    const panel=$('[data-p9d-action-panel]');
    if(panel&&!panel.hidden)panel.querySelector(panelSource==='auto'?'[data-p9d-action="close-panel"]':mode==='create'?'[data-p9d-new-name]':'[data-p9d-rename-name]')?.focus?.({preventScroll:true});
  }
  function chooseAction(action, id='') {
    if(busy)return;
    if(action==='close-panel'){
      panelMode='';panelKind='';panelName='';panelSource='';choiceOpen=false;folderSignature='';renderManager();
      if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});returnFocus=null;return;
    }
    if(action==='create-scope'){actionPanel('create',id);return;}
    if(action==='edit-scope'){
      const [kind,name,origin='']=id.split('\u0000');if(!name)return;
      actionPanel('edit',kind,name,origin);return;
    }
    if(action==='folder'){
      folder=folder===id?'':id;facet='';facetName='';selectedSongId='';choiceTerm='';choiceOpen=false;panelMode='';
      const input=$('[data-p9d-choice-search]');if(input)input.value='';renderManager();return;
    }
    if(action==='facet'){
      const [kind,name]=id.split('\u0000');if(!['groups','tags','classifiers'].includes(kind)||!name)return;
      if(facet===kind && facetName===name){facet='';facetName='';}else{facet=kind;facetName=name;}
      panelMode='';selectedSongId='';choiceTerm='';choiceOpen=false;folderSignature='';
      const input=$('[data-p9d-choice-search]');if(input)input.value='';renderManager();return;
    }
    if(action==='filter-classifier'){
      organizer.cycleFocus?.('classifier',id);navSignature='';renderClassifiers();return;
    }
    if(action==='pick-song'){
      const song=eligibleSongs().find(song=>String(song.id)===id);
      if(!canAdd(song))return;
      selectedSongId=id;choiceOpen=false;
      const input=$('[data-p9d-choice-search]');if(input)input.value=song?.title||'';
      renderChoices();return;
    }
    if(action==='edit-song'){
      if(!selectedMembers().some(song=>String(song.id)===id))return;
      window.EveAudioflixPianoFrontendSettings?.open?.(id,'settings');return;
    }
    if(!front.bridgeReady?.()){note('Connect Piano Backend before editing.','error');return;}
    // Song-row Remove always acts on the visible scope, not on a floating editor.
    const memberRow=action==='remove-song';
    const name=memberRow?(facet?facetName:folder):panelMode==='edit'?panelName:(facet?facetName:folder);
    const kind=memberRow?(facet||'folder'):panelMode==='edit'?panelKind:(facet||'folder');
    const base=memberRow?selectedMembers():scopeMembersFor(kind,name);
    if(action==='add'){
      if(panelMode!=='edit'||panelSource==='auto')return;
      const song=eligibleSongs().find(song=>String(song.id)===selectedSongId);
      if(!canAdd(song))return;
      const payload=payloadFor(song,kind,name,'add');
      if(payload)void sendPlan([{song,payload}],`Added to ${name}`);return;
    }
    if(action==='create'){
      if(panelMode!=='create')return;
      const fresh=scopeName(),createKind=panelKind;
      const song=eligibleSongs().find(item=>String(item.id)===selectedSongId);
      if(!fresh||!canAddFor(song,createKind,fresh)){
        note('Enter a scope name and choose an eligible song to assign.','error');return;
      }
      const payload=payloadFor(song,createKind,fresh,'add');
      if(payload)void sendPlan([{song,payload}],`Created ${fresh}`,
        createKind==='folder'?fresh:folder,createKind==='folder'?'':createKind,createKind==='folder'?'':fresh);
      return;
    }
    if(!name||(kind==='classifiers'&&(panelSource==='auto'||!editableClassifier(kind,name)))){
      note('Derived classifiers are read-only; edit authored Genres in song Settings.','error');return;
    }
    if(action==='remove-song'){
      const song=base.find(item=>String(item.id)===id);if(!song)return;
      if(kind==='classifiers'&&!genreOf(song).includes(name)){
        note('This classification is automatic; it cannot be removed from song metadata.','error');return;
      }
      if(kind==='groups'&&!assignedGroups(song).includes(name)){
        note('This group is inherited from Piano tab metadata; open song Settings to change it.','error');return;
      }
      if(!window.confirm(`Remove “${song.title}” from ${name}? The song itself will not be deleted.`))return;
      const payload=payloadFor(song,kind,name);if(payload)void sendPlan([{song,payload}],`Removed membership from ${name}`);return;
    }
    const editable=kind==='groups'?base.filter(song=>assignedGroups(song).includes(name)):
      kind==='classifiers'?base.filter(song=>genreOf(song).includes(name)):base;
    if(action==='rename'){
      if(panelMode!=='edit')return;
      const next=$('[data-p9d-rename-name]')?.value.trim()||'';
      if(!next||next===name||next.length>80){note('Enter a different scope name (up to 80 characters).','error');return;}
      if(!window.confirm(`Rename ${name} to ${next} for ${editable.length} songs?`))return;
      const plan=editable.map(song=>({song,payload:swapPayload(song,kind,name,next)}));
      void sendPlan(plan,`Renamed ${name} to ${next}`,kind==='folder'&&folder===name?next:folder,
        kind!=='folder'&&facet===kind&&facetName===name?kind:facet,
        kind!=='folder'&&facet===kind&&facetName===name?next:facetName);return;
    }
    if(action==='remove-scope'){
      if(panelMode!=='edit')return;
      if(!window.confirm(`Remove ${name} membership from ${editable.length} songs? Songs and unrelated metadata remain.`))return;
      const plan=editable.map(song=>({song,payload:payloadFor(song,kind,name)}));
      void sendPlan(plan,`Removed ${name} memberships`,kind==='folder'&&folder===name?'':folder,
        facet===kind&&facetName===name?'':facet,facet===kind&&facetName===name?'':facetName);
    }
  }
  function install() {
    const c=canvas(),manager=c?.querySelector('[data-pfo-manager]');
    if(!c||!manager||manager.dataset.p9d2Installed)return;
    manager.dataset.p9d2Installed='1';manager.classList.add('p9d-folder-manager','p9d-scope-manager');
    manager.innerHTML=`<div class="p9d-folder-head"><strong>Edit Scopes</strong><span>Choose a folder or All, then a facet. ✎ edits and + creates scope entries.</span></div>
      <div class="p9d-folder-picks"><strong>Folders</strong><div data-p9d-folder-choices class="p9d-scope-choices" role="group" aria-label="Folder editing context"></div></div>
      <section data-p9d-editor class="p9d-editor"><div class="p9d-editor-head"><strong data-p9d-location>All library</strong><small data-p9d-current-scope>All library scopes</small></div>
      <div class="p9d-taxonomy">${['groups','tags','classifiers'].map(kind=>`<details><summary data-p9d-${kind}-count>${kind}</summary><button type="button" data-p9d-action="create-scope" data-p9d-value="${kind}" class="p9d-plus-trigger" aria-label="Create ${kind}">+</button><input type="search" data-p9d-${kind}-search placeholder="Filter ${kind}" aria-label="Search ${kind}"><div data-p9d-${kind} class="p9d-scope-choices"></div></details>`).join('')}</div>
      <details data-p9d-songs-section class="p9d-member-section"><summary data-p9d-members-count>Songs in scope</summary><input type="search" data-p9d-member-search placeholder="Search songs in scope" aria-label="Search songs in scope"><div data-p9d-members class="p9d-members"></div></details>
      <div class="p9d-modal-backdrop" data-p9d-backdrop hidden></div><section class="p9d-action-panel" data-p9d-action-panel id="p9d-action-panel" role="dialog" aria-modal="true" aria-labelledby="p9d-action-title" hidden><div class="p9d-action-head"><strong id="p9d-action-title" data-p9d-action-title>Edit scope</strong><button type="button" data-p9d-action="close-panel" aria-label="Close scope editor">×</button></div><small data-p9d-action-help></small>
        <div data-p9d-inspect-row hidden><strong>Read-only automatic classification</strong><p data-p9d-inspect-count></p><p>Assigned by the Piano classifier. Use this scope to filter songs; its name and membership cannot be edited here.</p></div>
        <div data-p9d-create-row><label>New scope name<input data-p9d-new-name maxlength="80" placeholder="Name" autocomplete="off"></label></div>
        <div data-p9d-rename-row><label>Scope name<input data-p9d-rename-name maxlength="80" placeholder="Scope name" autocomplete="off"></label><button type="button" data-p9d-action="rename">Rename</button></div>
        <div data-p9d-add-seed><label>Choose an unassigned song</label><div class="p9d-picker"><input data-p9d-choice-search type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="p9d-choices" placeholder="Search songs by title or artist" autocomplete="off" aria-label="Find an eligible song"><div data-p9d-choices id="p9d-choices" class="p9d-choices" role="listbox" hidden></div></div><small data-p9d-eligible-count></small><button type="button" data-p9d-action="create">Create with song</button><button type="button" data-p9d-action="add">Add selected song</button></div>
        <div data-p9d-remove-row><button type="button" data-p9d-action="remove-scope" class="p9d-danger">Remove scope memberships</button></div>
      </section><div class="p9d-context-note" data-p9d-context>All library</div><span data-p9d-note role="status">Select a folder or group/tag scope to manage songs.</span></section>`;
    const closeFloating=()=>{if(!panelMode)return;panelMode='';panelKind='';panelName='';panelSource='';choiceOpen=false;folderSignature='';renderManager();};
    const tool=c.querySelector('[data-pfo-action="organize"]');if(tool){tool.textContent='Edit Scopes';tool.addEventListener('click',()=>{if(manager.hidden)reset();else closeFloating();});}
    c.querySelector('.piano-pfo-actions')?.addEventListener('click',e=>{
      if(e.target.closest?.('[data-pfo-action]:not([data-pfo-action="organize"])'))closeFloating();});
    c.querySelector('[data-pfo-action="classifiers"]')?.remove();
    c.querySelector('[data-pfo-classifier-panel]')?.remove();
    const scopes=c.querySelector('.piano-pfo-library-scopes');
    if(scopes&&!scopes.querySelector('[data-p9d-classifier-scope]')){
      const row=document.createElement('div');row.className='p9d-classifier-row';
      row.innerHTML='<strong>Classifiers:</strong><div class="p9d-classifier-splits" data-p9d-classifier-splits>' +
        ['auto','custom'].map(kind=>`<details data-p9d-classifier-scope="${kind}"><summary><span data-p9d-classifier-count="${kind}">${kind}</span> <span class="p9d-chevron">▸</span></summary><input type="search" data-p9d-classifier-search="${kind}" placeholder="Filter ${kind} classifiers" aria-label="Filter ${kind} classifiers"><div data-p9d-classifier-list="${kind}" class="p9d-scope-chips"></div></details>`).join('')+'</div>';
      scopes.append(row);
      row.querySelectorAll('[data-p9d-classifier-search]').forEach(input=>input.addEventListener('input',e=>{
        classifierTerm[e.target.dataset.p9dClassifierSearch]=e.target.value;navSignature='';renderClassifiers();}));
      row.querySelectorAll('[data-p9d-classifier-scope]').forEach(details=>details.addEventListener('toggle',()=>renderClassifiers()));
    }
    manager.querySelector('[data-p9d-backdrop]')?.addEventListener('click',()=>chooseAction('close-panel'));
    manager.addEventListener('click',e=>{const el=e.target.closest?.('[data-p9d-action]');
      if(el&&manager.contains(el))chooseAction(el.dataset.p9dAction,el.dataset.p9dValue||'');});
    manager.addEventListener('keydown',e=>{if(!panelMode)return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();chooseAction('close-panel');return;}
      if(e.key==='Tab') {const panel=$('[data-p9d-action-panel]');
        const focusable=[...panel.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(el=>!el.closest('[hidden]'));
        if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    c.querySelector('.piano-pfo-library-scopes')?.addEventListener('click',e=>{
      const el=e.target.closest?.('[data-p9d-action="filter-classifier"]');
      if(el)chooseAction('filter-classifier',el.dataset.p9dValue||'');});
    manager.addEventListener('input',e=>{
      if(e.target.matches('[data-p9d-member-search]')){memberTerm=e.target.value;renderMembers(songs());}
      else if(e.target.matches('[data-p9d-choice-search]')){choiceTerm=e.target.value;selectedSongId='';choiceOpen=true;renderChoices();}
      else if(e.target.matches('[data-p9d-new-name]')){selectedSongId='';renderChoices();}
      else if(e.target.matches('[data-p9d-groups-search],[data-p9d-tags-search],[data-p9d-classifiers-search]'))renderFacets(songs());
    });
    const combobox=manager.querySelector('[data-p9d-choice-search]');
    combobox.addEventListener('focus',()=>{if(!panelMode)return;choiceOpen=true;renderChoices();});
    const picker=manager.querySelector('.p9d-picker');
    const hidePicker=()=>{choiceOpen=false;const list=$('[data-p9d-choices]');
      if(list)list.hidden=true;combobox.setAttribute('aria-expanded','false');};
    document.addEventListener('pointerdown',e=>{if(choiceOpen&&!picker.contains(e.target))hidePicker();});
    picker.addEventListener('focusout',e=>{if(!picker.contains(e.relatedTarget))hidePicker();});
    combobox.addEventListener('keydown',e=>{
      const choices=[...manager.querySelectorAll('.p9d-choose-item')];
      if(e.key==='Escape'){choiceOpen=false;renderChoices();return;}
      if(e.key==='ArrowDown'&&choices.length){e.preventDefault();choices[0].focus();}
      if(e.key==='Enter'&&choices.length){e.preventDefault();chooseAction('pick-song',choices[0].dataset.p9dValue);}
    });
    manager.querySelector('[data-p9d-choices]').addEventListener('keydown',e=>{
      const choices=[...manager.querySelectorAll('.p9d-choose-item')],i=choices.indexOf(document.activeElement);
      if(e.key==='Escape'){combobox.focus();choiceOpen=false;renderChoices();}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();choices[Math.min(choices.length-1,Math.max(0,i+(e.key==='ArrowDown'?1:-1)))]?.focus();}
    });
    reset();renderClassifiers();
  }
  const oldMount=front.mount,oldDecorate=ports.decorateSongs;
  front.mount=h=>{oldMount(h);host=h||host;install();};
  ports.decorateSongs=(target,visible,all)=>{oldDecorate(target,visible,all);if(canvas()){
    if(!$('[data-pfo-manager]')?.hidden)renderManager();renderClassifiers();}};
  Object.assign(ns,{ready:true,install,reset,refreshClassifiers:renderClassifiers,membersFor,scopeMembersFor,membershipPlan,labelsFor,classifierSets,autoOnly,scoped,inFacet,eligibleSongs,canAddFor,payloadFor,swapPayload});
})(window.EveAudioflixPianoV9DFolders=window.EveAudioflixPianoV9DFolders||{},
  window.EveAudioflixPianoFrontend,window.EveAudioflixPianoFrontendPorts,
  window.EveAudioflixPianoTaxonomy,window.EveAudioflixPianoFrontendOrganize);
