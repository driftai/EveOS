// Panel markup and transient projection. Library/queue state stays with its existing owners.
window.EveAudioflixUiPanel = window.EveAudioflixUiPanel || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixUiPanel;
    if (ns.ready) return;
    ns.syncButtons = function (container, html) {
        const next = document.createElement('template'); next.innerHTML = html;
        const wanted = [...next.content.children], retained = new Set(), ordered = [];
        for (const child of wanted) {
            const key = child.dataset.afAction;
            const current = [...container.children].find(node => node.dataset.afAction === key);
            const node = current || child;
            if (current) {
                for (const attribute of [...current.attributes]) if (!child.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
                for (const attribute of [...child.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
                if (current.innerHTML !== child.innerHTML) current.innerHTML = child.innerHTML;
            }
            retained.add(node);
            ordered.push(node);
        }
        // Remove obsolete siblings first: retained controls often already have the wanted
        // relative order. Moving a focused control merely past removed siblings blurs it.
        for (const child of [...container.children]) if (!retained.has(child)) child.remove();
        for (const [index, node] of ordered.entries()) {
            if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
        }
    };
    ns.create = function (ctx) {
        const { state, esc, closeSvg, hotkeyComboIssue, renderItems, renderAddSection } = ctx;
        let addMarkup = '', drawerState = {};
        const renderModalHost = () => ctx.modal();
        const renderLibrary = (items, type) => { addMarkup = renderAddSection(type); return `<div class="audioflix-add-host" style="display:contents">${addMarkup}</div><div class="audioflix-library-host" style="display:contents">${renderItems(items, type)}</div>`; };
        const syncAddHost = (host, html) => {
            const template = document.createElement('template'); template.innerHTML = html;
            const nextRow = [...template.content.children].find(node => node.classList?.contains('audioflix-add-section-row'));
            const currentRow = [...host.children].find(node => node.classList?.contains('audioflix-add-section-row'));
            if (!nextRow || !currentRow) { host.innerHTML = html; return; }
            ns.syncButtons(currentRow, nextRow.innerHTML);
            for (const attribute of [...currentRow.attributes]) if (!nextRow.hasAttribute(attribute.name)) currentRow.removeAttribute(attribute.name);
            for (const attribute of [...nextRow.attributes]) if (currentRow.getAttribute(attribute.name) !== attribute.value) currentRow.setAttribute(attribute.name, attribute.value);
            for (const child of [...host.children]) if (child !== currentRow) child.remove();
            for (const child of [...template.content.children]) if (child !== nextRow) host.appendChild(child);
        };
        const focusIdentity = element => element ? ['afAction', 'afId', 'afType', 'afScope', 'afGroup', 'afDimension']
            .reduce((out, key) => { if (element.dataset[key] !== undefined) out[key] = element.dataset[key]; return out; }, {}) : null;
        const restoreFocus = (root, identity) => {
            if (!identity || !Object.keys(identity).length) return;
            const attributes = { afAction: 'data-af-action', afId: 'data-af-id', afType: 'data-af-type', afScope: 'data-af-scope', afGroup: 'data-af-group', afDimension: 'data-af-dimension' };
            let target = null;
            if (window.CSS?.escape) {
                const selector = Object.entries(identity).map(([key, value]) => `[${attributes[key]}="${CSS.escape(String(value))}"]`).join('');
                target = selector ? root.querySelector(selector) : null;
            }
            if (!target) target = [...root.querySelectorAll('[data-af-action]')].find(node => Object.entries(identity).every(([key, value]) => node.dataset[key] === value));
            target?.focus?.({ preventScroll: true });
        };
        const measured = (name, operation) => {
            let finish, failed = false;
            try { finish = window.EveAudioflixDiagnostics?.span?.(name); } catch { /* optional telemetry */ }
            try { return operation(); }
            catch (error) { failed = true; throw error; }
            finally { try { finish?.(failed); } catch { /* optional telemetry */ } }
        };
        const EAGER_MATERIALIZE_SOURCE_LIMIT = 40 * 100;
        const EAGER_MATERIALIZE_OVERSCAN_PX = 154;
        const materializeVisiblePagedCards = (panel, host) => {
            const viewport = panel.getBoundingClientRect();
            const eagerBottom = viewport.bottom + EAGER_MATERIALIZE_OVERSCAN_PX;
            const visible = [];
            for (const card of host.querySelectorAll('.audioflix-item-grid[data-af-window-owner] > .audioflix-item-card')) {
                const box = card.getBoundingClientRect();
                if (box.bottom <= viewport.top) continue;
                if (box.top >= eagerBottom) break;
                visible.push(card);
            }
            // Read all estimates first, then promote together. Descendant readbacks inside
            // the loop repeatedly forced layout as each skipped subtree became relevant.
            for (const card of visible) card.style.contentVisibility = 'visible';
        };
        function render() {
            const { activeTab, fullscreenOn, settingsOpen, portedSounds } = ctx.view(), tools = ctx.tools();
            const snapshot = state(), musicCount = snapshot.music?.length || 0, soundCount = (snapshot.soundboard?.length || 0) + portedSounds.length, routedCount = snapshot.counters?.routedGeminiEvents || 0;
            drawerState = { settingsOpen, routingOpen: ctx.view().routingOpen, combo: snapshot.hotkeyBypassCombo || '' };
            const soundboardItems = [...(snapshot.soundboard || []), ...portedSounds];
            const tabBody = activeTab === 'music'
                ? renderLibrary(snapshot.music || [], 'music')
                : activeTab === 'piano' ? (tools.piano?.render?.() || '<div class="audioflix-empty">Piano-Auto-Player is unavailable.</div>') : activeTab === 'soundlab'
                    ? (tools.soundLab?.render?.() || '<div class="audioflix-empty">Sonic Forge is unavailable.</div>')
                    : activeTab === 'router'
                        ? (ctx.tools().routing?.renderRouter?.(snapshot) || '')
                        : renderLibrary(soundboardItems, 'sound');
            return `<div class="audioflix-panel" data-af-tab="${esc(activeTab)}" role="dialog" aria-modal="true" aria-labelledby="audioflix-title"><header class="audioflix-header"><div><span class="audioflix-kicker">EveOS Audio Backend</span><h2 id="audioflix-title">Audioflix</h2><p>Soundboard, music library, piano automation, generative audio, and routed playback in one workspace.</p></div><div class="audioflix-header-actions"><button type="button" class="audioflix-clear-events" data-af-action="clear-gemini-events">Clear events</button><span>${soundCount} sounds · ${musicCount} tracks · ${routedCount} Gemini events</span><button type="button" class="audioflix-settings-toggle${settingsOpen ? ' is-active' : ''}" data-af-action="toggle-settings" title="Audioflix settings (hotkey bypass)" aria-label="Audioflix settings">⚙</button><button type="button" class="audioflix-fullscreen-toggle${fullscreenOn ? ' is-active' : ''}" data-af-action="toggle-fullscreen">⛶</button><button type="button" data-af-action="close">${closeSvg}</button></div></header><nav class="audioflix-tabs">${tabButton('soundboard', 'Soundboard')}${tabButton('music', 'Music Library')}${tabButton('piano', 'Piano-Auto-Player')}${tabButton('soundlab', 'Sonic Forge')}${tabButton('router', 'Routing Notes')}</nav>${renderSettings(snapshot)}${renderRoutingDrawer(snapshot)}<div class="audioflix-content">${tabBody}</div><div class="audioflix-modal-host">${renderModalHost()}</div></div>`;
        }

        const renderSettings = (snapshot) => { const { settingsOpen } = ctx.view(); const combo = snapshot.hotkeyBypassCombo || '', issue = hotkeyComboIssue(combo), active = ctx.frontendActiveGroup('sound'), bound = active.items.filter(item => item.hotkey).length, summary = `${active.name}: ${bound} bound · bypass ${combo ? esc(combo) : 'not set'}`; return !settingsOpen ? `<section class="audioflix-settings-drawer"><button type="button" class="audioflix-routing-summary" data-af-action="toggle-settings"><span>Hotkey Settings</span><strong>Visible-group sound hotkeys</strong><em>${summary}</em><b>Open settings</b></button></section>` : `<section class="audioflix-settings-drawer is-open"><button type="button" class="audioflix-routing-summary" data-af-action="toggle-settings"><span>Hotkey Settings</span><strong>Visible-group sound hotkeys</strong><em>${summary}</em><b>Collapse</b></button><div class="audioflix-settings-body"><label class="audioflix-settings-field"><span>Hotkey bypass toggle key</span><input type="text" class="audioflix-bypass-input${issue?.invalid ? ' audioflix-input-invalid' : ''}" placeholder="Press a key or combination" value="${esc(combo)}" title="${issue ? esc(issue.msg) : 'Press this to suspend/resume all sound hotkeys'}"></label><p class="audioflix-settings-hint">Press a key combination directly into either hotkey field. Only sounds in the selected Frontend group are armed; changing groups deliberately replaces the active set. Closing Audioflix or showing Backend view keeps that selected group armed. Press the bypass key in-game to <strong>suspend</strong> or re-arm it. If localhost is unavailable, sound keys and the bypass still work while Audioflix is open and focused; only system-wide/background capture is unavailable.</p><div class="audioflix-bypass-controls"><div class="audioflix-bypass-status">Hotkey reach: <span class="audioflix-bypass-state" data-state="unknown">CHECKING…</span></div><button type="button" class="audioflix-bypass-toggle" data-af-action="toggle-hotkey-bypass" data-bypassed="false" aria-pressed="false">Activate bypass</button></div></div></section>`; };
        const renderRoutingDrawer = (snapshot) => { const { routingOpen, playbackStatus } = ctx.view(); const routeLabel = snapshot.nativeBridgeEnabled && snapshot.nativeOutputLabel ? snapshot.nativeOutputLabel : (snapshot.preferredSinkLabel || 'Default browser output'), stateLabel = snapshot.nativeBridgeEnabled ? 'Native route active' : (snapshot.geminiVoicePortEnabled ? 'Voice Port armed' : 'Local playback'); return `<section class="audioflix-routing-drawer ${routingOpen ? 'is-open' : ''}"><button type="button" class="audioflix-routing-summary" data-af-action="toggle-routing-drawer"><span>Audio Output / Voice Port</span><strong>${esc(stateLabel)}</strong><em>${esc(routeLabel)}</em><b>${routingOpen ? 'Collapse' : 'Open routing'}</b></button>${routingOpen ? `<div class="audioflix-routing-body">${ctx.tools().routing?.renderStatusCards?.(snapshot, playbackStatus) || ''}${ctx.tools().narration?.renderAudioflixSummary?.() || ''}<section class="audioflix-player"><div><strong>Waveform</strong><span>${esc(playbackStatus)}</span></div><canvas id="audioflix-waveform" height="90"></canvas><button type="button" data-af-action="pause">Pause</button></section></div>` : ''}</section>`; };

        const tabButton = (tab, label) => `<button type="button" class="${ctx.view().activeTab === tab ? 'active' : ''}" data-af-action="tab" data-af-tab="${tab}">${label}</button>`;

        function library(root) {
            const tab = ctx.view().activeTab, panel = root?.querySelector('.audioflix-panel');
            if (!['music', 'soundboard'].includes(tab) || panel?.dataset.afTab !== tab) return false;
            const addHost = panel.querySelector('.audioflix-add-host'), host = panel.querySelector('.audioflix-library-host');
            if (!addHost || !host) return false;
            const focusedAction = document.activeElement?.closest?.('[data-af-action]');
            const focus = focusIdentity(focusedAction);
            const scrollTop = panel.scrollTop, scrollLeft = panel.scrollLeft, snapshot = state(), type = tab === 'music' ? 'music' : 'sound';
            const items = type === 'music' ? (snapshot.music || []) : [...(snapshot.soundboard || []), ...(ctx.view().portedSounds || [])];
            const projection = measured('ui:panel:library:markup', () => ({ add: renderAddSection(type), items: renderItems(items, type) }));
            measured('ui:panel:library:mount', () => {
                if (addMarkup !== projection.add) { syncAddHost(addHost, projection.add); addMarkup = projection.add; }
                host.innerHTML = projection.items;
            });
            measured('ui:panel:library:restore', () => {
                // Zero is the browser's natural position; rewriting it after connected-DOM replacement
                // can force an otherwise avoidable style/layout flush on the common cold-view path.
                if (scrollTop) panel.scrollTop = scrollTop;
                if (scrollLeft) panel.scrollLeft = scrollLeft;
                if (!focusedAction?.isConnected || document.activeElement !== focusedAction) restoreFocus(panel, focus);
            });
            // Finish connected-DOM writes before measuring the viewport/card estimates.
            measured('ui:panel:library:sync', () => {
                window.EveAudioflixTransport?.sync?.(host);
                window.EveAudioflixLayerVoices?.render?.(host);
            });
            if (type === 'music'
                && (snapshot.musicViewMode || 'backend') === 'frontend'
                && (snapshot.music?.length || 0) <= EAGER_MATERIALIZE_SOURCE_LIMIT) {
                measured('ui:panel:library:materialize-visible', () => materializeVisiblePagedCards(panel, host));
            }
            return true;
        }

        function transient(root) {
            const tab = ctx.view().activeTab, panel = root?.querySelector('.audioflix-panel');
            if (!['music', 'soundboard'].includes(tab) || panel?.dataset.afTab !== tab) return false;
            const host = panel.querySelector('.audioflix-add-host');
            if (!host) return false;
            const type = tab === 'music' ? 'music' : 'sound';
            const nexus = ctx.playback?.().nexus || {};
            const needsNexusPanel = nexus.open === true && nexus.type === type;
            const hasNexusPanel = !!host.querySelector('.audioflix-nexus-panel');
            // Drawer-only changes must not rebuild Nexus/facets/duplicate analysis. Only refresh the
            // add host when its Nexus panel actually needs to appear or disappear.
            if (needsNexusPanel !== hasNexusPanel) {
                const nexusUi = ctx.playback?.().nexusUi;
                const toggle = host.querySelector(
                    `[data-af-action="toggle-nexus"][data-af-type="${type}"]`
                );

                if (!needsNexusPanel) {
                    // Closing Nexus only removes its own bounded panel. Replacing the full add-host
                    // destroys unrelated toolbar controls and can delay the following compositor frame.
                    host.querySelector('.audioflix-nexus-panel')?.remove();
                    toggle?.classList.remove('is-active');

                    // The mounted DOM was changed surgically. Invalidate the full-markup equality
                    // shortcut so a later structural refresh can rebuild the canonical host markup.
                    addMarkup = '';
                } else if (typeof nexusUi?.renderPanel === 'function') {
                    const row = host.querySelector('.audioflix-add-section-row');
                    const html = nexusUi.renderPanel(type);

                    if (row && html) {
                        // renderAddSection places Nexus directly after the toolbar row.
                        row.insertAdjacentHTML('afterend', html);
                        toggle?.classList.add('is-active');
                        addMarkup = '';
                    } else {
                        const full = renderAddSection(type);
                        if (addMarkup !== full) {
                            host.innerHTML = full;
                            addMarkup = full;
                        }
                    }
                } else {
                    const full = renderAddSection(type);
                    if (addMarkup !== full) {
                        host.innerHTML = full;
                        addMarkup = full;
                    }
                }
            }
            const snapshot = state(), view = ctx.view(), changes = [];
            if (drawerState.settingsOpen !== view.settingsOpen || drawerState.combo !== (snapshot.hotkeyBypassCombo || '')) changes.push(['.audioflix-settings-drawer', renderSettings(snapshot)]);
            if (drawerState.routingOpen !== view.routingOpen) changes.push(['.audioflix-routing-drawer', renderRoutingDrawer(snapshot)]);
            for (const [selector, markup] of changes) {
                const current = panel.querySelector(selector), template = document.createElement('template');
                template.innerHTML = markup;
                if (current && current.outerHTML !== template.content.firstElementChild.outerHTML) {
                    current.replaceWith(template.content.firstElementChild);
                    if (selector === '.audioflix-routing-drawer') {
                        window.EveAudioflixAudio?.attachWaveform?.(panel.querySelector('#audioflix-waveform'));
                        window.EveAudioflixRouting?.populateOutputSelectors?.(panel);
                        ctx.tools().narration?.syncAudioflixSummary?.();
                    }
                }
            }
            drawerState = { settingsOpen: view.settingsOpen, routingOpen: view.routingOpen, combo: snapshot.hotkeyBypassCombo || '' };
            panel.querySelector('.audioflix-settings-toggle')?.classList.toggle('is-active', ctx.view().settingsOpen);
            return true;
        }
        function playback(root) {
            if (!root || root.hidden) return;
            const live = ctx.playback();
            live.queue.syncQueueControls(root); live.status(); window.EveAudioflixTransport?.sync?.(root);
            if (live.nexus.open) {
                const results = root.querySelector(`[data-af-nexus-results="${live.nexus.type}"]`);
                if (results) results.innerHTML = live.nexusUi.renderResults(live.nexus.type);
            }
        }
        return { render, library, transient, playback };
    };
    ns.ready = true;
})();
