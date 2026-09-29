'use strict';
const entries = [{ id: 'tools', popup: 'hub.html', label: 'Tools' },
  ...globalThis.EveOSExtensionModuleEntries.filter(item => item.popup)];
const frames = new Map(), buttons = new Map();
const sourceWindow = chrome.windows.getCurrent();
const nav = document.querySelector('nav');
const views = document.getElementById('views');
let activeId = 'tools';

async function select(id) {
  const entry = entries.find(item => item.id === id);
  if (!entry) return;
  activeId = id;
  const window = await sourceWindow;
  if (activeId !== id) return;
  let frame = frames.get(id);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = `view-${id}`; frame.title = entry.label; frame.setAttribute('role', 'tabpanel');
    frame.setAttribute('aria-labelledby', `tab-${id}`);
    frame.addEventListener('load', () => {
      // Theme only our same-origin tool UI; canonical standalone assets stay unchanged.
      const document = frame.contentDocument;
      if (!document || document.getElementById('bridge-surface-theme')) return;
      document.documentElement.dataset.bridgeView = id;
      const theme = document.createElement('link');
      theme.id = 'bridge-surface-theme'; theme.rel = 'stylesheet';
      theme.href = chrome.runtime.getURL('bridge-surfaces.css');
      document.head.append(theme);
    });
    frame.src = `${entry.popup}?windowId=${window.id}`;
    frames.set(id, frame); views.append(frame);
  }
  for (const [key, item] of frames) item.hidden = key !== id;
  for (const [key, button] of buttons) button.setAttribute('aria-selected', String(key === id));
}

for (const entry of entries) {
  const button = document.createElement('button');
  button.id = `tab-${entry.id}`; button.textContent = entry.label;
  button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `view-${entry.id}`);
  button.onclick = () => void select(entry.id).catch(error => {
    document.getElementById('popupStatus').textContent = error.message;
  });
  nav.append(button); buttons.set(entry.id, button);
}
nav.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const index = entries.findIndex(entry => buttons.get(entry.id) === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length;
  buttons.get(entries[next].id).focus(); buttons.get(entries[next].id).click();
});
window.addEventListener('message', event => {
  if (event.source !== frames.get('tools')?.contentWindow || event.origin !== location.origin
      || event.data?.channel !== 'eveos.bridge.navigate.v1') return;
  void select(event.data.moduleId).catch(error => {
    document.getElementById('popupStatus').textContent = error.message;
  });
});
void select('tools').catch(error => { document.getElementById('popupStatus').textContent = error.message; });
