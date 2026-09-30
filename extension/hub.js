'use strict';

const protocol = globalThis.EveOSExtensionProtocol;
const servicesHost = document.querySelector('[data-services]');
const connectorsHost = document.querySelector('[data-connectors]');
const status = document.querySelector('[data-status]');
const layout = globalThis.EveOSBridgeUIState.create({ chromeApi:chrome,
  onError:error => { status.textContent = `Could not save layout: ${error.message}`; } });
let refreshVersion = 0;

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function serviceCard(item) {
  const detail = item.online ? (item.detail?.message || 'Ready') : 'Not running';
  return `<details class="card" data-collapse="service:${escapeHtml(item.id)}"><summary><strong>${escapeHtml(item.name)}</strong><span class="badge ${item.online ? 'online' : ''}">${item.online ? 'ONLINE' : 'OFFLINE'}</span></summary><div class="card-body"><small>${escapeHtml(detail)}</small><button type="button" data-open-service="${escapeHtml(item.id)}">Open</button></div></details>`;
}

function connectorCard(item) {
  const capabilities = item.capabilities.length ? item.capabilities.join(' · ') : 'Connector protocol ready';
  const actions = (item.actions || []).map(action => {
    const input = action.input?.kind === 'text'
      ? `<input data-connector-input="${escapeHtml(item.extensionId)}:${escapeHtml(item.id)}:${escapeHtml(action.id)}" placeholder="${escapeHtml(action.input.placeholder || '')}" aria-label="${escapeHtml(action.label)} input">`
      : '';
    return `<div class="connector-action">${input}<button type="button" data-invoke-connector="${escapeHtml(item.extensionId)}" data-connector-id="${escapeHtml(item.id)}" data-action-id="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>${action.description ? `<small>${escapeHtml(action.description)}</small>` : ''}</div>`;
  }).join('');
  return `<details class="card connector-card" data-collapse="connector:${escapeHtml(item.id)}:${escapeHtml(item.extensionId)}"><summary><strong>${escapeHtml(item.name)}</strong><span class="badge online">${item.integration === 'included' ? 'INCLUDED' : 'CONNECTED'}</span></summary><div class="card-body"><small>${escapeHtml(capabilities)}</small><button type="button" data-open-connector="${escapeHtml(item.extensionId)}" data-connector-id="${escapeHtml(item.id)}">Open tool</button>${actions ? `<div class="connector-actions">${actions}</div>` : ''}</div></details>`;
}

async function render(snapshot, version) {
  const services = document.createElement('div'), connectors = document.createElement('div');
  services.innerHTML = (snapshot.services || []).map(serviceCard).join('') || '<div class="empty">No EveOS services registered.</div>';
  connectors.innerHTML = (snapshot.connectors || []).map(connectorCard).join('')
    || '<div class="empty">No companion extensions discovered yet.</div>';
  await Promise.all([layout.bind(services), layout.bind(connectors)]);
  if (version !== refreshVersion) return;
  servicesHost.replaceChildren(...services.childNodes);
  connectorsHost.replaceChildren(...connectors.childNodes);
  status.textContent = `Updated ${new Date(snapshot.generatedAt || Date.now()).toLocaleTimeString()}`;
}

async function send(type, detail = {}) {
  return chrome.runtime.sendMessage({ channel: protocol.UI_CHANNEL, type, ...detail });
}

async function refresh(type = 'refresh') {
  const version = ++refreshVersion;
  status.textContent = type === 'scan' ? 'Discovering EveOS companions...' : 'Refreshing EveOS...';
  const result = await send(type);
  if (!result?.ok) throw new Error(result?.message || result?.code || 'EveOS Bridge request failed.');
  await render(result.snapshot, version);
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.action === 'refresh') await refresh();
    else if (target.dataset.action === 'discover') {
      const granted = await chrome.permissions.request({ permissions: ['management'] });
      if (!granted) throw new Error('Companion discovery permission was not granted.');
      await refresh('scan');
    } else if (target.dataset.openService) {
      target.disabled = true;
      status.textContent = target.dataset.openService === 'nexus-browser' ? 'Opening Nexus Browser; starting it if needed…' : 'Opening service…';
      const result = await send('open-service', { id: target.dataset.openService });
      if (!result?.ok) throw new Error(result?.message || 'Could not open the service.');
      status.textContent = result.detail?.message || 'Service opened.';
    } else if (target.dataset.openConnector) {
      target.disabled = true;
      status.textContent = 'Opening tool through EveOS; starting it if needed…';
      const result = await send('open-connector', { extensionId: target.dataset.openConnector, id: target.dataset.connectorId });
      if (!result?.ok) throw new Error(result?.message || result?.code || 'Companion could not be opened.');
      if (result.detail?.uiModule) parent.postMessage({ channel: 'eveos.bridge.navigate.v1', moduleId: result.detail.uiModule }, location.origin);
      else status.textContent = result.detail?.message || 'Tool opened.';
    } else if (target.dataset.invokeConnector) {
      const extensionId = target.dataset.invokeConnector;
      const action = target.dataset.actionId;
      const id = target.dataset.connectorId;
      const selector = `[data-connector-input="${CSS.escape(extensionId)}:${CSS.escape(id)}:${CSS.escape(action)}"]`;
      const input = document.querySelector(selector);
      const result = await send('invoke-connector', { extensionId, id, action, value: input?.value || '' });
      if (!result?.ok) throw new Error(result?.message || result?.code || 'Companion action failed.');
      status.textContent = result.detail?.message || 'Companion action completed.';
    }
  } catch (error) {
    status.textContent = error?.message || String(error);
  } finally { if (target.isConnected) target.disabled = false; }
});

void layout.bind(document).then(() => refresh()).catch(error => { status.textContent = error?.message || String(error); });
